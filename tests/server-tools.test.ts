// The probe's own tools are registered with registerTool and declare an
// outputSchema, and their structured results honor it (the SDK validates
// structuredContent against the schema before sending a success).

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const probeBin = resolve(__dirname, "..", "dist/index.js");

describe("probe tools", () => {
  it("all six declare an outputSchema and annotations", async () => {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [probeBin],
        env: getDefaultEnvironment(),
        stderr: "pipe",
      })
    );
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "probe_connect",
        "probe_disconnect",
        "probe_fuzz",
        "probe_lint",
        "probe_list",
        "probe_report",
      ]);
      for (const t of tools) {
        expect(t.outputSchema?.type, t.name).toBe("object");
        expect(t.annotations, t.name).toBeDefined();
      }
      // A success result validates against its schema (the client checks too).
      const r = await client.callTool({ name: "probe_disconnect", arguments: {} });
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent).toEqual({ removed: 0, remaining: 0, defaultConnectionId: null });
    } finally {
      await client.close();
    }
  });
});
