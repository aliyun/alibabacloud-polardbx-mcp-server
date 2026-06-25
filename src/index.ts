#!/usr/bin/env node
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as dotenv from 'dotenv';
import mysql, {FieldPacket} from 'mysql2/promise';

export interface TableRow {
  table_name: string
}

export interface ColumnRow {
  column_name: string
  data_type: string
}

// 加载环境变量
dotenv.config();

const dbHost = process.env.POLARDB_X_HOST;
if (!dbHost) {
  throw new Error('POLARDB_X_HOST is required');
}
const dbPort = parseInt(process.env.POLARDB_X_PORT ?? '');
if (isNaN(dbPort) || dbPort <= 0 || dbPort > 65535) {
  throw new Error('POLARDB_X_PORT must be a valid number between 1 and 65535');
}
const dbUser = process.env.POLARDB_X_USER;
if (!dbUser) {
  throw new Error('POLARDB_X_USER is required');
}
const dbPassWord = process.env.POLARDB_X_PASSWORD;
if (!dbPassWord) {
  throw new Error('POLARDB_X_PASSWORD is required');
}
const dbName = process.env.POLARDB_X_DATABASE;
if (!dbName) {
  throw new Error('POLARDB_X_DATABASE is required');
}
const dbReadOnly = (process.env.POLARDB_X_READ_ONLY ?? 'true').toLocaleLowerCase() === 'true';
const dbSqlSelectLimit = parseInt(process.env.POLARDB_X_SQL_SELECT_LIMIT ?? '100');
if (isNaN(dbSqlSelectLimit) || dbSqlSelectLimit <= 0) {
  throw new Error('POLARDB_X_SQL_SELECT_LIMIT must be a valid positive number');
}

let polarDbXPoolOptions: mysql.PoolOptions = {
  host: dbHost,
  port: dbPort,
  user: dbUser,
  password: dbPassWord,
  database: dbName,
  connectionLimit: 10,
  waitForConnections: true,
  queueLimit: 0,
  // 禁止多语句,从驱动层拦截 "SELECT 1; DROP TABLE" 这类堆叠注入
  multipleStatements: false,
};

// 只读模式下允许的语句首关键字白名单
const READ_ONLY_LEADING_KEYWORDS = ['SELECT', 'WITH', 'SHOW', 'DESC', 'DESCRIBE', 'EXPLAIN', 'USE'];

/**
 * 只读模式下校验 SQL:剥离注释后,要求首关键字落在只读白名单内。
 * 剥离注释可防止 `/* SELECT *​/ DROP TABLE` 这类注释绕过。
 */
function assertReadOnlySql(sql: string): void {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // 块注释 /* ... */
    .replace(/--[^\n]*/g, ' ')          // 行注释 -- ...
    .replace(/#[^\n]*/g, ' ')           // 行注释 # ...
    .trim();
  if (stripped === '') {
    throw new Error('Empty SQL statement is not allowed');
  }
  const leading = stripped.match(/^[a-zA-Z]+/)?.[0]?.toUpperCase() ?? '';
  if (!READ_ONLY_LEADING_KEYWORDS.includes(leading)) {
    throw new Error(
      `Read-only mode: statement starting with "${leading || stripped.slice(0, 16)}" is not allowed. ` +
      `Allowed: ${READ_ONLY_LEADING_KEYWORDS.join(', ')}. ` +
      `Set POLARDB_X_READ_ONLY=false to enable write operations.`
    );
  }
}

class PolarDBXServer {
  private server: Server;
  private polardbxConnPool: Promise<mysql.Pool>;

  constructor() {
    this.server = new Server(
      {
        name: 'polardbx-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
        instructions: 'PolarDB-X MCP servers'
      }
    );

    this.polardbxConnPool = new Promise((resolve, reject) => {
      try {
        const pool = mysql.createPool(polarDbXPoolOptions)
        resolve(pool)
      } catch (error) {
        reject(error)
      }
    });

    this.setupToolHandlers();

    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "query",
          description: "Run a SQL query on PolarDB-X",
          inputSchema: {
            type: "object",
            properties: {
              sql: {type: "string"},
            },
          },
        },
        {
          name: "inspect database status",
          description: "Inspect the status of PolarDB-X",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "show all commands",
          description: "Show all commands SQL for PolarDB-X",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === "query") {
        const sql = request.params.arguments?.sql as string;
        if (typeof sql !== 'string' || sql.trim() === '') {
          throw new Error('Parameter "sql" must be a non-empty string');
        }
        // 只读模式下做语句级校验,确保只读保证不依赖事务兜底
        if (dbReadOnly) {
          assertReadOnlySql(sql);
        }

        const [result] = await this.executeQuery(sql);
        return {
          content: [{type: "text", text: JSON.stringify(result, null, 2)}],
          isError: false,
        };
      } else if (request.params.name === "inspect database status") {
        const [result] = await this.executeQuery("show stats");
        return {
          content: [{type: "text", text: JSON.stringify(result, null, 2)}],
          isError: false,
        };
      } else if (request.params.name === "show all commands") {
        const [result] = await this.executeQuery("show help");
        return {
          content: [{type: "text", text: JSON.stringify(result, null, 2)}],
          isError: false,
        };
      }
      throw new Error(`Unknown tool: ${request.params.name}`);

    });

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const [rows] = (await this.executeQuery<TableRow[]>(`SELECT table_name as table_name
                                                           FROM information_schema.tables
                                                           WHERE table_schema = DATABASE()`));
      return {
        resources: rows.map((row: TableRow) => ({
          uri: `polardbx://${dbName}/${row.table_name}`,
          mimeType: 'application/json',
          name: `"${row.table_name}" table schema`,
        })),
      };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      try {
        const resourceUrl = new URL(request.params.uri)
        const pathComponents = resourceUrl.pathname.split('/')
        const tableName = pathComponents.pop()
        const schema = pathComponents.pop()

        // Modify query to include schema information
        let columnsQuery = 'SELECT column_name, data_type FROM information_schema.columns WHERE table_name = ?'
        let queryParams = [tableName as string]

        if (schema != null) {
          columnsQuery += ' AND table_schema = ?'
          queryParams.push(schema)
        }

        const [results] = (await this.executeQuery<ColumnRow[]>(
          columnsQuery,
          queryParams,
        ))

        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: 'application/json',
              text: JSON.stringify(results, null, 2),
            },
          ],
        }
      } catch (error) {
        throw error
      }
    });
  }

  private async executeQuery<T>(
    sql: string,
    params: string[] = [],
  ): Promise<[T, FieldPacket[]]> {
    let currentConn: mysql.PoolConnection | undefined;
    try {
      currentConn = await (await this.polardbxConnPool).getConnection();
      await currentConn.query('SET SESSION sql_select_limit = ?', [dbSqlSelectLimit]);
      // 开启只读事务
      if (dbReadOnly) {
        await currentConn.query('START TRANSACTION READ ONLY');
      }
      const result = await currentConn.query(sql, params);
      // 提交事务
      if (dbReadOnly) {
        await currentConn.query('COMMIT');
      }
      return result as [T, FieldPacket[]];
    } catch (error) {
      console.error('执行SQL查询时出错:', error);
      // 在发生错误时也尝试提交，避免事务挂起
      if (currentConn && dbReadOnly) {
        try {
          await currentConn.query('ROLLBACK');
        } catch (rollbackError) {
          console.error('提交事务时出错:', rollbackError);
        }
      }
      throw error;
    } finally {
      if (currentConn) {
        currentConn.release(); // 确保连接释放回池中
      }
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('[INFO] polardbx-mcp MCP server running on stdio');
  }
}

const server = new PolarDBXServer();
server.run().catch(error => {
  console.error('[ERROR] MCP Server failed to start:', error);
  process.exit(1);
});
