import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
const TOKEN = process.env.GATE_TOKEN || "sk-demo-123";
function buildMcp() {
  const mcp = new McpServer({ name: "gated-demo", version: "1.0.0" });
  mcp.tool("echo", "Echo a message back.", { message: z.string().describe("Message to echo.") },
    async ({ message }) => ({ content: [{ type: "text", text: message }] }));
  mcp.tool("divide", "Divide two numbers.", { a: z.number(), b: z.number() },
    async ({ a, b }) => ({ content: [{ type: "text", text: String(a / b) }] }));
  return mcp;
}
const server = createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" })); return;
  }
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body; try { body = raw ? JSON.parse(raw) : undefined; } catch { res.writeHead(400).end("bad json"); return; }
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => t.close());
    try { await buildMcp().connect(t); await t.handleRequest(req, res, body); }
    catch (e) { if (!res.headersSent) res.writeHead(500); res.end(String(e.message)); }
  });
});
server.listen(8848, "127.0.0.1", () => console.error("gated MCP server on http://127.0.0.1:8848/mcp"));
