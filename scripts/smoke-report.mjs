// Smoke test for AC-6.
//
// Spawns the probe's stdio server, opens a connection to the bundled
// demo target, runs `probe_report` with `fuzz: true`, and asserts the
// returned Markdown contains:
//   1. an overall 0–100 score;
//   2. a letter grade (one of A/B/C/D/F);
//   3. four per-dimension sections, each with a "X / 10" score and
//      a concrete reason list;
//   4. a Findings summary section;
//   5. a Fuzz table section.
//
// Also asserts the structured payload (overall, grade, four
// dimensions) is internally consistent and that the rendered Markdown
// matches it. Exit 0 on success; non-zero on any failure.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED_DIMENSIONS = [
  "Metadata & Documentation",
  "Schema Quality",
  "Error Handling",
  "Liveness & Performance",
];

function fail(msg) {
  console.error(`[smoke-report] FAIL: ${msg}`);
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
  { name: "smoke-report", version: "0.0.0" },
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

  // (2) Run probe_report with fuzz: true.
  const reportResult = await client.callTool({
    name: "probe_report",
    arguments: { fuzz: true },
  });
  if (reportResult.isError) {
    fail(
      `probe_report returned isError: ${reportResult.content?.[0]?.text ?? "(no message)"}`
    );
  }

  let payload;
  try {
    payload = JSON.parse(reportResult.content?.[0]?.text ?? "{}");
  } catch (e) {
    fail(
      `probe_report returned non-JSON payload: ${(reportResult.content?.[0]?.text ?? "").slice(0, 200)}`
    );
  }

  // (3) Structured payload must have overall, grade, dimensions, and
  //     markdown. Validate the structured fields first so the Markdown
  //     assertions below are anchored to a known-good scorecard.
  if (typeof payload.overall !== "number" || payload.overall < 0 || payload.overall > 100) {
    fail(
      `payload.overall is not a 0..100 number: ${JSON.stringify(payload.overall)}`
    );
  }
  if (!["A", "B", "C", "D", "F"].includes(payload.grade)) {
    fail(`payload.grade is not a letter grade: ${JSON.stringify(payload.grade)}`);
  }
  if (!Array.isArray(payload.dimensions) || payload.dimensions.length !== 4) {
    fail(
      `payload.dimensions must be an array of 4 entries, got ${payload.dimensions?.length ?? "undefined"}`
    );
  }
  for (const label of EXPECTED_DIMENSIONS) {
    if (!payload.dimensions.some((d) => d.label === label)) {
      fail(`payload.dimensions missing '${label}': got [${payload.dimensions.map((d) => d.label).join(", ")}]`);
    }
  }
  for (const d of payload.dimensions) {
    if (typeof d.score !== "number" || d.score < 0 || d.score > 10) {
      fail(`dimension '${d.label}' has invalid score: ${JSON.stringify(d.score)}`);
    }
    if (!Array.isArray(d.reasons) || d.reasons.length === 0) {
      fail(`dimension '${d.label}' has empty reason list`);
    }
    if (typeof d.notMeasured !== "boolean") {
      fail(`dimension '${d.label}' has invalid notMeasured: ${JSON.stringify(d.notMeasured)}`);
    }
  }

  // (4) Markdown is the headline payload — assert it contains every
  //     required section from the spec.
  const md = typeof payload.markdown === "string" ? payload.markdown : "";
  if (md.length === 0) {
    fail("payload.markdown is empty");
  }

  // (4a) Overall score in the form "N / 100".
  const overallRe = /\*\*Overall score:\*\*\s+(\d+)\s*\/\s*100/;
  const overallMatch = md.match(overallRe);
  if (!overallMatch) {
    fail(
      `markdown missing 'Overall score: N / 100' line. First 400 chars:\n${md.slice(0, 400)}`
    );
  }
  const mdOverall = Number(overallMatch[1]);
  if (mdOverall !== payload.overall) {
    fail(
      `markdown overall (${mdOverall}) disagrees with payload.overall (${payload.overall})`
    );
  }

  // (4b) Grade line: "**Grade:** X"
  const gradeRe = /\*\*Grade:\*\*\s+([ABCDF])/;
  const gradeMatch = md.match(gradeRe);
  if (!gradeMatch) {
    fail(
      `markdown missing '**Grade:** X' line. First 400 chars:\n${md.slice(0, 400)}`
    );
  }
  if (gradeMatch[1] !== payload.grade) {
    fail(
      `markdown grade (${gradeMatch[1]}) disagrees with payload.grade (${payload.grade})`
    );
  }
  // (4b.ii) Grade must be derivable from overall via spec §7 thresholds.
  const expectedGradeFromOverall =
    mdOverall >= 90 ? "A"
      : mdOverall >= 75 ? "B"
      : mdOverall >= 60 ? "C"
      : mdOverall >= 40 ? "D"
      : "F";
  if (expectedGradeFromOverall !== gradeMatch[1]) {
    fail(
      `grade (${gradeMatch[1]}) doesn't match the spec's thresholds for overall=${mdOverall} (expected ${expectedGradeFromOverall})`
    );
  }

  // (4c) Four per-dimension sections, each with a "X / 10" score and
  //      a concrete reason list. We require the literal section
  //      headings in the documented order.
  let cursor = 0;
  for (const label of EXPECTED_DIMENSIONS) {
    const headingRe = new RegExp(
      `### ${escapeRe(label)}: ([^\\n]+)`
    );
    const slice = md.slice(cursor);
    const m = slice.match(headingRe);
    if (!m) {
      fail(
        `markdown missing or out-of-order dimension section '${label}'. Looked from offset ${cursor}:\n${slice.slice(0, 400)}`
      );
    }
    const headingText = m[1];
    // Each dimension must show "X / 10" (or "not measured").
    if (headingText.includes("not measured")) {
      // The behavioral dimensions when fuzz=false are reported as
      // "not measured" — fine. We required fuzz: true, so all four
      // should be measured, but be tolerant.
      if (label === "Metadata & Documentation" || label === "Schema Quality") {
        fail(
          `static dimension '${label}' should not be 'not measured' when fuzz=true. Heading: '${headingText}'`
        );
      }
    } else if (!/\d+(?:\.\d+)?\s*\/\s*10/.test(headingText)) {
      fail(
        `dimension '${label}' heading missing 'X / 10' score: '${headingText}'`
      );
    }
    // Advance cursor past the heading so the next dimension must
    // appear AFTER it (asserts ordering).
    cursor += slice.indexOf(m[0]) + m[0].length;
    // After the heading, there must be at least one bullet point
    // (a concrete reason). Find the next section heading (a line
    // starting with '##' or '###'), not the empty line that
    // separates sections.
    const afterHeading = md.slice(cursor);
    const nextSection = afterHeading.search(/^#{2,3}\s/m);
    const reasonSlice =
      nextSection >= 0 ? afterHeading.slice(0, nextSection) : afterHeading;
    if (!/-\s+\S/.test(reasonSlice)) {
      fail(
        `dimension '${label}' has no concrete reason bullets after its heading. Body:\n${reasonSlice.slice(0, 300)}`
      );
    }
  }

  // (4d) Findings summary section.
  if (!/^##\s+Findings summary/m.test(md)) {
    fail(
      `markdown missing '## Findings summary' section. First 600 chars:\n${md.slice(0, 600)}`
    );
  }
  // Findings section must be present even if there are no findings,
  // but the demo has known findings so the line should not be empty.
  const findingsSection = md.split(/^##\s+Findings summary/m)[1] ?? "";
  if (!/^No lint findings/m.test(findingsSection) && !/finding\(s\):/m.test(findingsSection)) {
    fail(
      `Findings summary section has unexpected content: ${findingsSection.slice(0, 300)}`
    );
  }

  // (4e) Fuzz table section (markdown table with header + separator).
  if (!/^##\s+Fuzz table/m.test(md)) {
    fail(
      `markdown missing '## Fuzz table' section. Last 600 chars:\n${md.slice(-600)}`
    );
  }
  const fuzzSection = md.split(/^##\s+Fuzz table/m)[1] ?? "";
  // Header + separator row + at least one data row.
  if (!/\| Tool \| Case \| Outcome \| Silent \| Latency \(ms\) \| Notes \|/.test(fuzzSection)) {
    fail(
      `Fuzz table header row missing or malformed: ${fuzzSection.slice(0, 300)}`
    );
  }
  if (!/\| --- \| --- \| --- \| --- \| --- \| --- \|/.test(fuzzSection)) {
    fail(
      `Fuzz table separator row missing: ${fuzzSection.slice(0, 300)}`
    );
  }
  // We expect at least one data row (the demo has 4 tools × ≥3
  // cases, so well over one).
  const tableRows = fuzzSection.split("\n").filter((l) => l.startsWith("|") && !l.startsWith("| ---") && !l.startsWith("| Tool"));
  if (tableRows.length < 4) {
    fail(
      `Fuzz table has only ${tableRows.length} data rows, expected at least 4: ${fuzzSection.slice(0, 400)}`
    );
  }

  // (5) Sanity: the report payload must contain the same number of
  //     findings and fuzz rows as the smoke-fuzz and smoke-lint
  //     scripts would produce (≥1 finding, ≥1 fuzz result).
  if (!Array.isArray(payload.findings) || payload.findings.length === 0) {
    fail(`payload.findings is empty: ${JSON.stringify(payload.findings)}`);
  }
  if (!Array.isArray(payload.fuzz) || payload.fuzz.length === 0) {
    fail(`payload.fuzz is empty: ${JSON.stringify(payload.fuzz)}`);
  }

  // (6) Report uses the project terminology (use these terms).
  const expected = ["conformance", "grade", "findings", "dimensions"];
  const lower = md.toLowerCase();
  for (const term of expected) {
    if (!lower.includes(term)) {
      fail(`markdown missing expected terminology '${term}'`);
    }
  }

  console.log(`[smoke-report] OK: overall=${payload.overall}/100 grade=${payload.grade}`);
  console.log(
    `[smoke-report] dimensions: ${payload.dimensions
      .map((d) => `${d.label}=${d.score}${d.notMeasured ? "(not measured)" : ""}`)
      .join(" | ")}`
  );
  console.log(
    `[smoke-report] findings: ${payload.findings.length}, fuzz rows: ${payload.fuzz.length}, markdown length: ${md.length} chars`
  );
  console.log("[smoke-report] PASS");
} catch (err) {
  fail(`unexpected error: ${err?.message ?? String(err)}`);
} finally {
  try {
    await client.close();
  } catch {
    // best-effort
  }
}

// Escape a literal string for use inside a RegExp.
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
