// A server that only speaks the legacy HTTP+SSE transport must still be
// auditable: the streamable-HTTP initialize POST is rejected (405 here), and
// connectHttp has to retry over SSE. Previously the fallback only caught
// constructor errors, which never happen, so these servers were unreachable.

import { describe, it, expect, afterAll } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { connectHttp, shouldFallBackToSse } from "../src/target-client.js";

function buildMcp(): McpServer {
  const mcp = new McpServer({ name: "legacy-sse", version: "1.0.0" });
  mcp.tool("ping", "Reply with pong.", { readOnlyHint: true }, async () => ({
    content: [{ type: "text" as const, text: "pong" }],
  }));
  return mcp;
}

const transports = new Map<string, SSEServerTransport>();
let status401 = false;
const server = createServer(async (req, res) => {
  if (status401) {
    res.writeHead(401).end();
    return;
  }
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "GET" && url.pathname === "/sse") {
    const t = new SSEServerTransport("/messages", res);
    transports.set(t.sessionId, t);
    res.on("close", () => transports.delete(t.sessionId));
    await buildMcp().connect(t);
    return;
  }
  if (req.method === "POST" && url.pathname === "/messages") {
    const t = transports.get(url.searchParams.get("sessionId") ?? "");
    if (!t) {
      res.writeHead(404).end();
      return;
    }
    await t.handlePostMessage(req, res);
    return;
  }
  // A streamable-HTTP POST to /sse lands here: legacy servers don't allow it.
  res.writeHead(405).end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address() as AddressInfo;
const sseUrl = `http://127.0.0.1:${port}/sse`;
afterAll(() => {
  server.closeAllConnections?.();
  server.close();
});

describe("legacy SSE fallback", () => {
  it("decides on fallback from the HTTP status", () => {
    expect(shouldFallBackToSse({ code: 405 })).toBe(true);
    expect(shouldFallBackToSse({ code: 404 })).toBe(true);
    expect(shouldFallBackToSse({ code: 400 })).toBe(true);
    expect(shouldFallBackToSse({ code: 401 })).toBe(false);
    expect(shouldFallBackToSse({ code: 500 })).toBe(false);
    expect(shouldFallBackToSse(new Error("socket hang up"))).toBe(false);
  });

  it("connects to an SSE-only server after streamable HTTP is rejected", async () => {
    const conn = await connectHttp({ url: sseUrl });
    try {
      expect(conn.serverInfo.name).toBe("legacy-sse");
      expect(conn.tools.map((t) => t.name)).toEqual(["ping"]);
    } finally {
      await conn.client.close();
    }
  });

  it("does not fall back on an auth failure", async () => {
    status401 = true;
    try {
      await expect(connectHttp({ url: sseUrl })).rejects.toThrow(/401|Unauthorized|Error POSTing/);
    } finally {
      status401 = false;
    }
  });
});
