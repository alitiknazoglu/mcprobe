// Smoke test for AC-2.
//
// Spawns the probe's stdio server, opens an MCP client against it, runs
// the initialize handshake, calls `tools/list`, and asserts that exactly
// the four core tools (probe_connect, probe_lint, probe_fuzz,
// probe_report) plus the two optional helpers (probe_list,
// probe_disconnect) come back, each with a non-empty JSON-Schema
// inputSchema.
//
// Exit code 0 on success; non-zero with a clear stderr message on any
// failed assertion.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CORE_TOOLS = [
  "probe_connect",
  "probe_lint",
  "probe_fuzz",
  "probe_report",
];
const OPTIONAL_TOOLS = ["probe_list", "probe_disconnect"];

function fail(msg) {
  console.error(`[smoke-list-tools] FAIL: ${msg}`);
  process.exit(1);
}

const probeBin = new URL("../dist/index.js", import.meta.url).pathname;

const transport = new StdioClientTransport({
  command: "node",
  args: [probeBin],
  // Pipe probe stderr through to ours so the operator sees the
  // "[mcprobe] stdio server ready" line as it would in production.
  stderr: "inherit",
});

const client = new Client(
  { name: "smoke-list-tools", version: "0.0.0" },
  { capabilities: {} }
);

try {
  await client.connect(transport);
  const { tools } = await client.listTools();

  const names = tools.map((t) => t.name).sort();
  console.log(`[smoke-list-tools] probe advertises ${tools.length} tool(s):`);
  for (const t of tools) {
    console.log(`  - ${t.name}`);
  }

  // 1. Every core tool must be present.
  for (const required of CORE_TOOLS) {
    if (!names.includes(required)) {
      fail(`missing core tool '${required}' (got: ${names.join(", ")})`);
    }
  }

  // 2. The two optional helpers should be present too (we ship them).
  for (const optional of OPTIONAL_TOOLS) {
    if (!names.includes(optional)) {
      fail(`missing optional helper '${optional}' (got: ${names.join(", ")})`);
    }
  }

  // 3. No surprise extras — keeps the surface predictable.
  const expected = [...CORE_TOOLS, ...OPTIONAL_TOOLS].sort();
  if (
    names.length !== expected.length ||
    !names.every((n, i) => n === expected[i])
  ) {
    fail(
      `unexpected tool set: got [${names.join(", ")}], expected [${expected.join(", ")}]`
    );
  }

  // 4. Every tool must have a non-empty JSON-Schema inputSchema with type=object.
  for (const t of tools) {
    if (!t.inputSchema || typeof t.inputSchema !== "object") {
      fail(`tool '${t.name}' has no inputSchema object`);
    }
    if (t.inputSchema.type !== "object") {
      fail(
        `tool '${t.name}' inputSchema.type is '${t.inputSchema.type}', expected 'object'`
      );
    }
    const props = t.inputSchema.properties;
    if (!props || typeof props !== "object") {
      fail(`tool '${t.name}' inputSchema has no 'properties' object`);
    }
  }

  console.log(
    `[smoke-list-tools] OK: all ${expected.length} tools present with non-empty input schemas`
  );
} catch (err) {
  fail(`unexpected error: ${err?.message ?? String(err)}`);
} finally {
  try {
    await client.close();
  } catch {
    // best-effort
  }
}
