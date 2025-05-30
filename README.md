# polardbx-mcp

A Model Context Protocol (MCP) servers which provides tools and resources, allowing AI agent to interact with Alibaba cloud [PolarDB-X](https://github.com/polardb/polardbx-sql) databases.

## Installation

### Option 1: Install from npm
```bash
# Install globally
npm install -g polardbx-mcp

# Or install in current project only
npm install polardbx-mcp
```

### Option 2: Build from source
1. Clone this repository:

2. Install dependencies and build:
```bash
npm install
npm run build
```
3. Configure the PolarDB-X connection in environment variable file `.env`:
```
POLARDB_X_HOST=your_database_host
POLARDB_X_PORT=your_database_port
POLARDB_X_USER=your_database_user
POLARDB_X_PASSWORD=your_database_password
POLARDB_X_DATABASE=your_database_name
```

4. Start the server:
```bash
npm start
```

## Configuration for MCP Client

Example Cline Configuration if you install from npm:

```
{
  "mcpServers": {
    "polardbx-mcp": {
      "command": "npx",
      "args": [
        "polardbx-mcp"
      ],
      "env": {
        "POLARDB_X_HOST": "your_database_host",
        "POLARDB_X_PORT": "your_database_port",
        "POLARDB_X_USER": "your_database_user",
        "POLARDB_X_PASSWORD": "your_database_password",
        "POLARDB_X_DATABASE": "your_database_name"
      },
    }
  }
}
```

Example Cline Configuration if you build from source:

```
{
  "mcpServers": {
    "polardbx-mcp": {
      "command": "node",
      "args": [
        "path_to_mcp/polardbx-mcp/build/index.js"
      ],
      "env": {
        "POLARDB_X_HOST": "your_database_host",
        "POLARDB_X_PORT": "your_database_port",
        "POLARDB_X_USER": "your_database_user",
        "POLARDB_X_PASSWORD": "your_database_password",
        "POLARDB_X_DATABASE": "your_database_name"
      },
    }
  }
}
```

## MCP Server Components

### Tools
- query: Run a SQL query on PolarDB-X
- inspect database status: Inspect the status of PolarDB-X
- show all commands: Show all commands SQL for PolarDB-X

### Resources
The server provides schema information for each table in the database:
- Table Schemas (polardbx://<database_name>/<table_name>)
  - JSON schema information for each table
  - Includes column names and data types