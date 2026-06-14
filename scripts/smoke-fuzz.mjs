// Smoke test for AC-5.
//
// Spawns the probe's stdio server, opens a connection to the bundled
// demo target, runs probe_fuzz, and asserts:
//   1. probe_fuzz returns at least one FuzzResult row per tool.
//   2. Every row has the stable fields:
//      name, case, outcome, silentlyAccepted, latencyMs.
//   3. well_behaved has at least one row with outcome="toolError"
//      (graceful rejection of a malformed case).
//   4. At least one of {greet, divide, set_mode} has a row with
//      silentlyAccepted=true on a malformed case.
//   5. The 3 outcomes are limited to the documented vocabulary
//      (ok, toolError, protocolCrash).
//   6. For at least one row, outcome="ok" && !silentlyAccepted (i.e.
//      the valid baseline actually succeeded somewhere).
//
// Exit 0 on success; non-zero with a clear stderr message on any
// failure.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SILENT_TOOLS = new Set(["greet", "divide", "set_mode"]);

function fail(msg) {
  console.error(`[smoke-fuzz] FAIL: ${msg}`);
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
  { name: "smoke-fuzz", version: "0.0.0" },
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

  // (2) Run probe_fuzz.
  const fuzzResult = await client.callTool({
    name: "probe_fuzz",
    arguments: {},
  });
  if (fuzzResult.isError) {
    fail(
      `probe_fuzz returned isError: ${fuzzResult.content?.[0]?.text ?? "(no message)"}`
    );
  }

  let payload;
  try {
    payload = JSON.parse(fuzzResult.content?.[0]?.text ?? "{}");
  } catch (e) {
    fail(
      `probe_fuzz returned non-JSON payload: ${(fuzzResult.content?.[0]?.text ?? "").slice(0, 200)}`
    );
  }

  const results = Array.isArray(payload.results) ? payload.results : [];
  if (results.length === 0) {
    fail("probe_fuzz returned zero results — expected at least one per tool");
  }

  // (3) Every row must have the 5 stable fields and the outcome
  //     must be in the documented vocabulary.
  for (const r of results) {
    for (const field of [
      "name",
      "case",
      "outcome",
      "silentlyAccepted",
      "latencyMs",
    ]) {
      if (!(field in r)) {
        fail(
          `fuzz row missing field '${field}': ${JSON.stringify(r).slice(0, 200)}`
        );
      }
    }
    if (typeof r.name !== "string" || r.name.length === 0) {
      fail(`fuzz row has invalid name: ${JSON.stringify(r.name)}`);
    }
    if (typeof r.case !== "string" || r.case.length === 0) {
      fail(`fuzz row has invalid case: ${JSON.stringify(r.case)}`);
    }
    if (!["ok", "toolError", "protocolCrash"].includes(r.outcome)) {
      fail(
        `fuzz row has unknown outcome '${r.outcome}' (case=${r.case}, tool=${r.name})`
      );
    }
    if (typeof r.silentlyAccepted !== "boolean") {
      fail(
        `fuzz row silentlyAccepted is not boolean: ${JSON.stringify(r.silentlyAccepted)}`
      );
    }
    if (typeof r.latencyMs !== "number" || r.latencyMs < 0) {
      fail(
        `fuzz row has invalid latencyMs: ${JSON.stringify(r.latencyMs)}`
      );
    }
  }

  // (4) well_behaved must have at least one toolError outcome (the
  //     graceful-rejection case required by AC-5).
  const wb = results.filter((r) => r.name === "well_behaved");
  if (wb.length === 0) {
    fail("expected fuzz results for 'well_behaved' tool, got none");
  }
  const wbToolErrors = wb.filter((r) => r.outcome === "toolError");
  if (wbToolErrors.length === 0) {
    fail(
      `well_behaved must reject a malformed case with toolError, got outcomes: ${wb
        .map((r) => `${r.case}=${r.outcome}`)
        .join(", ")}`
    );
  }
  // Sanity: the well_behaved "valid" case should succeed, and not be
  // flagged as silentlyAccepted.
  const wbValid = wb.find((r) => r.case === "valid");
  if (!wbValid || wbValid.outcome !== "ok" || wbValid.silentlyAccepted) {
    fail(
      `well_behaved valid case should be ok && !silentlyAccepted, got ${JSON.stringify(wbValid)}`
    );
  }

  // (5) At least one of greet/divide/set_mode must have a row with
  //     silentlyAccepted=true on a malformed case.
  const silentHits = results.filter(
    (r) =>
      r.silentlyAccepted === true &&
      SILENT_TOOLS.has(r.name) &&
      // Defensive: silentlyAccepted on a malformed case; the "valid"
      // case can never be silently accepted by the classifier.
      r.case !== "valid"
  );
  if (silentHits.length === 0) {
    const perTool = SILENT_TOOLS.has.bind(SILENT_TOOLS);
    const summary = results
      .filter((r) => perTool(r.name))
      .map((r) => `${r.name}/${r.case}=${r.outcome}/silent=${r.silentlyAccepted}`)
      .join(", ");
    fail(
      `expected at least one silentlyAccepted hit on greet/divide/set_mode, got none. Rows: ${summary}`
    );
  }
  // Total silentlyAccepted across all tools (the summary's
  // silentlyAccepted is the all-tools count, not the SILENT_TOOLS
  // subset; tools like well_behaved can also flag if the demo uses
  // zod's default strip mode).
  const totalSilent = results.filter((r) => r.silentlyAccepted === true)
    .length;
  if (totalSilent < silentHits.length) {
    fail(
      `internal: total silentlyAccepted (${totalSilent}) is less than the SILENT_TOOLS subset (${silentHits.length})`
    );
  }

  // (6) Summary histogram must be internally consistent.
  const summary = payload.summary;
  if (!summary || typeof summary !== "object") {
    fail(`probe_fuzz summary missing or non-object: ${JSON.stringify(summary)}`);
  }
  if (summary.total !== results.length) {
    fail(
      `summary.total (${summary.total}) disagrees with results.length (${results.length})`
    );
  }
  const reSum =
    (summary.ok ?? 0) +
    (summary.toolError ?? 0) +
    (summary.protocolCrash ?? 0);
  if (reSum !== summary.total) {
    fail(
      `summary histogram doesn't sum: ok=${summary.ok} + toolError=${summary.toolError} + protocolCrash=${summary.protocolCrash} = ${reSum}, expected ${summary.total}`
    );
  }
  if ((summary.silentlyAccepted ?? 0) !== totalSilent) {
    // (silentlyAccepted can in principle be > sum-of-ok if a case is
    // counted in both — but our generator never sets both, so the
    // counts should match exactly.)
    fail(
      `summary.silentlyAccepted (${summary.silentlyAccepted}) disagrees with row count (${totalSilent})`
    );
  }

  // (7) Per-tool breakdown must contain every tool the demo exposes.
  const perToolNames = new Set(
    (summary.perTool ?? []).map((p) => p.name)
  );
  for (const required of [
    "greet",
    "divide",
    "set_mode",
    "well_behaved",
  ]) {
    if (!perToolNames.has(required)) {
      fail(
        `summary.perTool missing tool '${required}': got [${Array.from(perToolNames).join(", ")}]`
      );
    }
  }

  // (8) At least one row should be ok && !silentlyAccepted (a
  //     valid case succeeded somewhere — sanity check that fuzz
  //     isn't broken end-to-end).
  const baseline = results.find(
    (r) => r.outcome === "ok" && r.silentlyAccepted === false
  );
  if (!baseline) {
    fail(
      `expected at least one ok && !silentlyAccepted row, got outcomes: ${results
        .map((r) => `${r.name}/${r.case}=${r.outcome}/silent=${r.silentlyAccepted}`)
        .join(", ")}`
    );
  }

  console.log(
    `[smoke-fuzz] OK: ${results.length} results across ${perToolNames.size} tools`
  );
  console.log(
    `[smoke-fuzz] outcomes: ok=${summary.ok} toolError=${summary.toolError} protocolCrash=${summary.protocolCrash} silentlyAccepted=${summary.silentlyAccepted}`
  );
  console.log(
    `[smoke-fuzz] well_behaved toolError rows: ${wbToolErrors.length} (e.g. ${wbToolErrors[0]?.case})`
  );
  console.log(
    `[smoke-fuzz] silentlyAccepted on {greet,divide,set_mode}: ${silentHits.length} row(s) (e.g. ${silentHits[0]?.name}/${silentHits[0]?.case})`
  );
  console.log("[smoke-fuzz] PASS");
} catch (err) {
  fail(`unexpected error: ${err?.message ?? String(err)}`);
} finally {
  try {
    await client.close();
  } catch {
    // best-effort
  }
}
