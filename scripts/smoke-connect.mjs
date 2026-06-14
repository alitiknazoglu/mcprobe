// Smoke test for AC-3.
//
// Spawns the probe's stdio server, calls probe_connect against the
// bundled demo target, and asserts:
//   1. The handshake returns { connectionId, name, version, capabilities, counts }.
//   2. counts.tools === 4 (greet, divide, set_mode, well_behaved).
//   3. A follow-up tool call (probe_list) defaults to the most recent
//      connection when no connectionId is supplied, proving the
//      "subsequent tool calls default to this connection" rule.
//   4. probe_disconnect clears the default and a follow-up probe_list
//      returns a clean isError result (no transport crash).
//
// Exit 0 on success; non-zero with a clear stderr message on any failure.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function fail(msg) {
  console.error(`[smoke-connect] FAIL: ${msg}`);
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
  { name: "smoke-connect", version: "0.0.0" },
  { capabilities: {} }
);

try {
  await client.connect(transport);

  // (1) probe_connect against the demo target.
  const connectResult = await client.callTool({
    name: "probe_connect",
    arguments: {
      transport: "stdio",
      command: "node",
      args: [demoBin],
    },
  });

  if (connectResult.isError) {
    const text = connectResult.content?.[0]?.text ?? "(no message)";
    fail(`probe_connect returned isError: ${text}`);
  }

  const connectText = connectResult.content?.[0]?.text ?? "";
  let outcome;
  try {
    outcome = JSON.parse(connectText);
  } catch {
    fail(`probe_connect returned non-JSON payload: ${connectText.slice(0, 200)}`);
  }

  for (const field of [
    "connectionId",
    "name",
    "version",
    "capabilities",
    "counts",
  ]) {
    if (!(field in outcome)) {
      fail(
        `probe_connect missing field '${field}' (got: ${Object.keys(outcome).join(", ")})`
      );
    }
  }
  if (
    typeof outcome.connectionId !== "string" ||
    outcome.connectionId.length === 0
  ) {
    fail(
      `connectionId is not a non-empty string: ${JSON.stringify(outcome.connectionId)}`
    );
  }
  if (outcome.name !== "demo-target") {
    fail(`expected name='demo-target', got '${outcome.name}'`);
  }
  if (typeof outcome.version !== "string" || outcome.version.length === 0) {
    fail(
      `version is not a non-empty string: ${JSON.stringify(outcome.version)}`
    );
  }
  if (typeof outcome.capabilities !== "object" || outcome.capabilities === null) {
    fail(
      `capabilities is not an object: ${JSON.stringify(outcome.capabilities)}`
    );
  }
  for (const key of ["tools", "resources", "prompts"]) {
    if (typeof outcome.counts?.[key] !== "number") {
      fail(
        `counts.${key} is not a number: ${JSON.stringify(outcome.counts?.[key])}`
      );
    }
  }
  if (outcome.counts.tools !== 4) {
    fail(
      `expected counts.tools === 4 (greet, divide, set_mode, well_behaved), got ${outcome.counts.tools}`
    );
  }

  console.log("[smoke-connect] probe_connect OK:");
  console.log(`  connectionId: ${outcome.connectionId}`);
  console.log(`  name: ${outcome.name}`);
  console.log(`  version: ${outcome.version}`);
  console.log(`  counts: ${JSON.stringify(outcome.counts)}`);
  console.log(`  defaultConnectionId: ${outcome.defaultConnectionId}`);

  // (2) Subsequent probe_list call must default to this connection
  //     when no connectionId is supplied.
  const listResult = await client.callTool({
    name: "probe_list",
    arguments: {},
  });
  if (listResult.isError) {
    const text = listResult.content?.[0]?.text ?? "(no message)";
    fail(`probe_list (default connection) returned isError: ${text}`);
  }
  const listText = listResult.content?.[0]?.text ?? "";
  let listPayload;
  try {
    listPayload = JSON.parse(listText);
  } catch {
    fail(`probe_list returned non-JSON payload: ${listText.slice(0, 200)}`);
  }
  if (listPayload.connectionId !== outcome.connectionId) {
    fail(
      `probe_list did not default to the most recent connection: got '${listPayload.connectionId}', expected '${outcome.connectionId}'`
    );
  }
  if (!Array.isArray(listPayload.tools) || listPayload.tools.length !== 4) {
    fail(
      `probe_list returned ${listPayload.tools?.length ?? 0} tools, expected 4`
    );
  }
  const expectedNames = ["greet", "divide", "set_mode", "well_behaved"].sort();
  const gotNames = listPayload.tools.map((t) => t.name).sort();
  if (gotNames.join(",") !== expectedNames.join(",")) {
    fail(
      `probe_list returned tool names [${gotNames.join(", ")}], expected [${expectedNames.join(", ")}]`
    );
  }
  console.log(
    `[smoke-connect] OK: default-connection probe_list returned ${listPayload.tools.length} tools (${gotNames.join(", ")})`
  );

  // (3) Explicit disconnect of the default connection should clear
  //     the default and a follow-up probe_list should return isError
  //     (no transport crash).
  const disconnectResult = await client.callTool({
    name: "probe_disconnect",
    arguments: { id: outcome.connectionId },
  });
  if (disconnectResult.isError) {
    const text = disconnectResult.content?.[0]?.text ?? "(no message)";
    fail(`probe_disconnect returned isError: ${text}`);
  }
  const disconnectPayload = JSON.parse(
    disconnectResult.content?.[0]?.text ?? "{}"
  );
  if (disconnectPayload.removed !== 1 || disconnectPayload.remaining !== 0) {
    fail(
      `probe_disconnect summary unexpected: ${JSON.stringify(disconnectPayload)}`
    );
  }
  if (disconnectPayload.defaultConnectionId !== null) {
    fail(
      `expected defaultConnectionId to become null after disconnect, got '${disconnectPayload.defaultConnectionId}'`
    );
  }

  const afterDisconnect = await client.callTool({
    name: "probe_list",
    arguments: {},
  });
  if (!afterDisconnect.isError) {
    fail("probe_list after disconnect should return isError, but returned a result");
  }
  const errText = afterDisconnect.content?.[0]?.text ?? "";
  if (!/no default connection/i.test(errText)) {
    fail(`expected 'no default connection' error after disconnect, got: ${errText}`);
  }
  console.log(
    "[smoke-connect] OK: disconnect clears default and errors cleanly"
  );

  console.log("[smoke-connect] PASS");
} catch (err) {
  fail(`unexpected error: ${err?.message ?? String(err)}`);
} finally {
  try {
    await client.close();
  } catch {
    // best-effort
  }
}
