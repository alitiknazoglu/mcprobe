// Smoke test for AC-4.
//
// Spawns the probe's stdio server, opens a connection to the bundled
// demo target, and asserts:
//   1. probe_lint returns at least one tool.missing_description finding
//   2. probe_lint returns at least one param.untyped finding
//   3. Every finding has the five required fields:
//      code, severity, message, location, hint
//   4. The 11-rule code set is a subset of the response (i.e. all
//      codes the spec requires are present in the FindingCode union
//      and a representative subset is exercised by the demo).
//   5. The demo's well_behaved tool (correctly-typed) generates no
//      findings for code 'param.untyped'.
//
// Exit 0 on success; non-zero with a clear stderr message on any failure.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REQUIRED_CODES = [
  "tool.missing_description",
  "tool.thin_description",
  "tool.duplicate_name",
  "tool.unusual_name",
  "tool.no_input_schema",
  "schema.invalid",
  "schema.root_not_object",
  "schema.no_required",
  "param.untyped",
  "param.missing_description",
  "server.no_tools",
];

function fail(msg) {
  console.error(`[smoke-lint] FAIL: ${msg}`);
  process.exit(1);
}

const probeBin = new URL("../dist/index.js", import.meta.url).pathname;
const demoBin = new URL(
  "../examples/demo-target/dist/index.js",
  import.meta.url
).pathname;

const transport = new StdioClientTransport({
  command: "node",
  args: [probeBin],
  stderr: "inherit",
});

const client = new Client(
  { name: "smoke-lint", version: "0.0.0" },
  { capabilities: {} }
);

try {
  await client.connect(transport);

  // (1) Open a connection to the demo.
  const connectResult = await client.callTool({
    name: "probe_connect",
    arguments: {
      transport: "stdio",
      command: "node",
      args: [demoBin],
    },
  });
  if (connectResult.isError) {
    fail(
      `probe_connect returned isError: ${connectResult.content?.[0]?.text ?? "(no message)"}`
    );
  }
  const connectPayload = JSON.parse(
    connectResult.content?.[0]?.text ?? "{}"
  );
  if (connectPayload.counts?.tools !== 4) {
    fail(
      `expected counts.tools === 4, got ${connectPayload.counts?.tools}`
    );
  }

  // (2) Run probe_lint.
  const lintResult = await client.callTool({
    name: "probe_lint",
    arguments: {},
  });
  if (lintResult.isError) {
    fail(
      `probe_lint returned isError: ${lintResult.content?.[0]?.text ?? "(no message)"}`
    );
  }

  let payload;
  try {
    payload = JSON.parse(lintResult.content?.[0]?.text ?? "{}");
  } catch (e) {
    fail(
      `probe_lint returned non-JSON payload: ${(lintResult.content?.[0]?.text ?? "").slice(0, 200)}`
    );
  }

  const findings = Array.isArray(payload.findings) ? payload.findings : [];
  if (findings.length === 0) {
    fail("probe_lint returned zero findings — expected several against the demo");
  }

  // (3) Every finding must have the 5 stable fields.
  for (const f of findings) {
    for (const field of ["code", "severity", "message", "location", "hint"]) {
      if (!(field in f)) {
        fail(
          `finding missing field '${field}': ${JSON.stringify(f).slice(0, 200)}`
        );
      }
    }
    if (typeof f.code !== "string" || f.code.length === 0) {
      fail(`finding has invalid code: ${JSON.stringify(f.code)}`);
    }
    if (!["error", "warning", "info"].includes(f.severity)) {
      fail(`finding has invalid severity '${f.severity}' (code=${f.code})`);
    }
    if (typeof f.message !== "string" || f.message.length === 0) {
      fail(`finding ${f.code} has empty message`);
    }
    if (typeof f.hint !== "string" || f.hint.length === 0) {
      fail(`finding ${f.code} has empty hint`);
    }
    if (typeof f.location !== "object" || f.location === null) {
      fail(`finding ${f.code} has non-object location`);
    }
  }

  // (4) At least one tool.missing_description and one param.untyped.
  const codes = new Set(findings.map((f) => f.code));
  if (!codes.has("tool.missing_description")) {
    fail(
      `expected at least one tool.missing_description finding; got codes: ${Array.from(codes).join(", ")}`
    );
  }
  if (!codes.has("param.untyped")) {
    fail(
      `expected at least one param.untyped finding; got codes: ${Array.from(codes).join(", ")}`
    );
  }

  // (5) The well_behaved tool (the demo's only correctly-typed tool) must
  //     not generate a param.untyped finding against itself.
  const untypedForWellBehaved = findings.filter(
    (f) => f.code === "param.untyped" && f.location?.tool === "well_behaved"
  );
  if (untypedForWellBehaved.length > 0) {
    fail(
      `well_behaved should have no param.untyped findings, got: ${JSON.stringify(untypedForWellBehaved)}`
    );
  }

  // (6) Every code in the response must belong to the 11-rule set.
  //     This is a guard against typos in the code strings.
  for (const f of findings) {
    if (!REQUIRED_CODES.includes(f.code)) {
      fail(
        `finding has unknown code '${f.code}' (not in the 11-rule set)`
      );
    }
  }

  // (7) Sanity: the demo's known flaw surface should hit at least
  //     these codes (param.missing_description is bonus).
  const expectedFromDemo = new Set([
    "tool.missing_description", // greet has no description
    "param.untyped",            // greet.name, divide.a, divide.b
    "param.missing_description",// greet.name (no description)
  ]);
  for (const c of expectedFromDemo) {
    if (!codes.has(c)) {
      fail(
        `expected demo to trip code '${c}' but it didn't. Codes seen: ${Array.from(codes).sort().join(", ")}`
      );
    }
  }

  console.log(
    `[smoke-lint] OK: ${findings.length} findings, ${
      payload.summary?.bySeverity?.error ?? 0
    } errors, ${payload.summary?.bySeverity?.warning ?? 0} warnings, ${
      payload.summary?.bySeverity?.info ?? 0
    } info`
  );
  console.log(`[smoke-lint] codes: ${Array.from(codes).sort().join(", ")}`);
  console.log("[smoke-lint] PASS");
} catch (err) {
  fail(`unexpected error: ${err?.message ?? String(err)}`);
} finally {
  try {
    await client.close();
  } catch {
    // best-effort
  }
}
