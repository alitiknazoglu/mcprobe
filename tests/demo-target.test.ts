// Integration test: the bundled demo target loads and registers
// the four documented tools.
//
// This test spawns `examples/demo-target/dist/index.js` as a child
// process and talks to it over stdio MCP via the SDK Client. The
// `pretest` script in package.json builds both the probe and the
// demo target before vitest runs, so by the time this test
// executes, `dist/index.js` is present for both.
//
// Exits non-zero if the demo target can't be reached, doesn't
// register exactly four tools, or the four names don't match the
// spec (greet, divide, set_mode, well_behaved).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const demoBin = resolve(repoRoot, "examples/demo-target/dist/index.js");

const EXPECTED_NAMES = ["divide", "greet", "set_mode", "well_behaved"].sort();

describe("demo-target fixtures", () => {
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;

  beforeAll(async () => {
    if (!existsSync(demoBin)) {
      throw new Error(
        `demo target not built: ${demoBin} missing — run \`npm run build\``
      );
    }
    transport = new StdioClientTransport({
      command: "node",
      args: [demoBin],
      stderr: "pipe",
    });
    client = new Client(
      { name: "demo-target-test", version: "0.0.0" },
      { capabilities: {} }
    );
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    try {
      await client?.close();
    } catch {
      // best-effort
    }
  });

  it("loads and registers exactly four tools", async () => {
    expect(client).toBeDefined();
    const { tools } = await client!.listTools();
    expect(tools.length).toBe(4);
  });

  it("the four tool names match the spec: greet, divide, set_mode, well_behaved", async () => {
    expect(client).toBeDefined();
    const { tools } = await client!.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(EXPECTED_NAMES);
  });

  it("each tool has a non-empty input schema with type=object and a properties object", async () => {
    expect(client).toBeDefined();
    const { tools } = await client!.listTools();
    for (const t of tools) {
      expect(t.name).toBeTruthy();
      expect(t.inputSchema).toBeTypeOf("object");
      expect((t.inputSchema as { type?: unknown }).type).toBe("object");
      expect(
        (t.inputSchema as { properties?: unknown }).properties
      ).toBeTypeOf("object");
    }
  });

  it("the initialize handshake reports a non-empty server name and version", async () => {
    expect(client).toBeDefined();
    const info = client!.getServerVersion();
    expect(info).toBeDefined();
    expect(info?.name).toBe("demo-target");
    expect(typeof info?.version).toBe("string");
    expect(info!.version.length).toBeGreaterThan(0);
  });

  it("the server advertises a non-empty capabilities object", async () => {
    expect(client).toBeDefined();
    const caps = client!.getServerCapabilities();
    expect(caps).toBeDefined();
    // The demo target's McpServer was constructed with { tools: {} }
    // so the tools capability must be present.
    expect((caps as { tools?: unknown }).tools).toBeDefined();
  });
});
