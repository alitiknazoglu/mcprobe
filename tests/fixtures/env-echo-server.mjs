// Test fixture: a stdio MCP server with one tool that reports which
// environment variable names it can see. Used to prove the probe does not
// leak its own environment into a spawned target.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "env-echo", version: "0.0.0" });
server.tool(
  "env",
  "Return the environment as JSON.",
  { readOnlyHint: true },
  async () => ({
    content: [{ type: "text", text: JSON.stringify(process.env) }],
  })
);
await server.connect(new StdioServerTransport());
