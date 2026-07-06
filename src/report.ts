// Pure Markdown report renderer. Takes a fully-populated
// ConformanceReport and returns a single Markdown string with the
// sections required by AC-6: overall score, letter grade, four
// per-dimension lines (each with a score and a concrete reason list),
// a findings summary, and a fuzz table.
//
// The renderer is intentionally pure: no I/O, no clock, no global
// state. That makes it trivial to unit-test and guarantees the
// output is stable across runs.

import type {
  ConformanceReport,
  Finding,
  FuzzCoverage,
  FuzzResult,
} from "./types.js";

const FINDING_SEVERITY_ORDER: Record<string, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** Render the conformance report as Markdown. The output is the
 *  payload returned by `probe_report`. Stable ordering and
 *  machine-parseable sub-headings (##, ###) so downstream tools can
 *  grep for sections. */
export function renderReport(report: ConformanceReport): string {
  const parts: string[] = [];
  parts.push(renderHeader(report));
  parts.push(renderDimensions(report));
  parts.push(renderFindingsSummary(report.findings));
  parts.push(renderFuzzTable(report.fuzz));
  parts.push(renderRecommendedFixes(report));
  return parts.join("\n\n") + "\n";
}

/** A prioritized to-do list. Turns the findings (and behavioral problems)
 *  into concrete fixes: each lint code is shown once with its hint and the
 *  locations it affects, worst severity first, followed by behavioral fixes
 *  for silent accepts and crashes. This is what makes the report a
 *  prescription, not just a diagnosis. */
function renderRecommendedFixes(report: ConformanceReport): string {
  const lines: string[] = ["## Recommended fixes", ""];
  const items: string[] = [];

  // Group lint findings by code so each fix is suggested once, with the
  // locations it affects. Order by worst severity first, then code.
  const severityRank: Record<string, number> = { error: 0, warning: 1, info: 2 };
  const byCode = new Map<
    string,
    { severity: string; hint: string; where: string[] }
  >();
  for (const f of report.findings) {
    const entry =
      byCode.get(f.code) ?? { severity: f.severity, hint: f.hint, where: [] };
    const loc = f.location.param
      ? `${f.location.tool ?? "?"}.${f.location.param}`
      : f.location.tool ?? "server";
    entry.where.push(loc);
    byCode.set(f.code, entry);
  }
  const sorted = [...byCode.entries()].sort(
    (a, b) =>
      (severityRank[a[1].severity] ?? 9) - (severityRank[b[1].severity] ?? 9) ||
      a[0].localeCompare(b[0])
  );
  for (const [code, e] of sorted) {
    items.push(`- **${e.severity}** ${e.hint} _(\`${code}\`: ${affected(e.where)})_`);
  }

  // Behavioral fixes — only when fuzz ran and there are issues.
  if (report.fuzz.length > 0) {
    const silentTools = [
      ...new Set(report.fuzz.filter((r) => r.silentlyAccepted).map((r) => r.name)),
    ];
    const crashTools = [
      ...new Set(
        report.fuzz.filter((r) => r.outcome === "protocolCrash").map((r) => r.name)
      ),
    ];
    const emptyTools = [
      ...new Set(report.fuzz.filter((r) => r.emptySuccess).map((r) => r.name)),
    ];
    const schemaTools = [
      ...new Set(report.fuzz.filter((r) => r.outputSchemaViolation).map((r) => r.name)),
    ];
    if (silentTools.length > 0) {
      items.push(
        `- **behavioral** Validate inputs and reject unknown keys (e.g. a strict schema) so malformed arguments return a clear error instead of being silently accepted _(${affected(silentTools)})_`
      );
    }
    if (emptyTools.length > 0) {
      items.push(
        `- **behavioral** Return a result payload that confirms what happened on success (e.g. the created id, a count, or a status message) so an agent can tell a real success from a silent no-op — an empty success reads as "done" when nothing happened _(${affected(emptyTools)})_`
      );
    }
    if (schemaTools.length > 0) {
      items.push(
        `- **behavioral** Make the success response honor the tool's declared outputSchema — return structuredContent that validates against it (or drop the schema if it's aspirational). An agent trusts the declared shape _(${affected(schemaTools)})_`
      );
    }
    if (crashTools.length > 0) {
      items.push(
        `- **behavioral** Guard against bad input before it throws, so the call returns a tool error instead of crashing the connection _(${affected(crashTools)})_`
      );
    }
  }

  if (items.length === 0) {
    lines.push("Nothing to fix — this server passes every check. ✓");
  } else {
    lines.push("Address these to raise the score, worst first:");
    lines.push("");
    lines.push(...items);
  }
  return lines.join("\n");
}

/** Format an affected-locations list, truncating long ones. */
function affected(where: string[]): string {
  if (where.length <= 5) return where.join(", ");
  return `${where.slice(0, 5).join(", ")} +${where.length - 5} more`;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function renderHeader(report: ConformanceReport): string {
  const lines: string[] = [];
  lines.push(`# MCProbe conformance report`);
  lines.push("");
  lines.push(
    `**Server:** \`${report.server.name}\` ${report.server.version}`
  );

  if (report.server.instructions) {
    const snippet = truncate(report.server.instructions, 120);
    lines.push(`**Instructions:** ${snippet}`);
  }

  lines.push(`**Overall score:** ${report.overall} / 100`);
  lines.push(`**Grade:** ${report.grade}`);
  if (report.coverage) {
    lines.push(renderCoverageLine(report.coverage));
  }
  // A flag (not a second score): the dangerous behavioral findings hoisted
  // to the top. Only shown when fuzz cases actually ran.
  if (report.fuzz.length > 0) {
    lines.push(renderCriticalLine(report.fuzz));
  }
  return lines.join("\n");
}

/** A one-line fuzz coverage summary for the report header. Shown only when
 *  fuzzing ran, so the behavioral score's coverage is explicit. */
function renderCoverageLine(c: FuzzCoverage): string {
  const parts = [`fuzzed ${c.fuzzedTools} of ${c.totalTools} tool(s)`];
  if (c.skippedDestructive.length > 0) {
    parts.push(
      `${c.skippedDestructive.length} skipped as destructive (${c.skippedDestructive.join(", ")})`
    );
  }
  if (c.skippedOverCap.length > 0) {
    parts.push(`${c.skippedOverCap.length} skipped over the maxTools cap`);
  }
  return `**Coverage:** ${parts.join("; ")}`;
}

/** A critical-issues callout: the silently-accepted and crashing behaviors,
 *  summarized in one line so they're visible above the fold. This is a flag,
 *  not a score — the normalized scores are unchanged. */
function renderCriticalLine(fuzz: FuzzResult[]): string {
  const silentTools = new Set(
    fuzz.filter((r) => r.silentlyAccepted).map((r) => r.name)
  );
  const emptyTools = new Set(
    fuzz.filter((r) => r.emptySuccess).map((r) => r.name)
  );
  const schemaTools = new Set(
    fuzz.filter((r) => r.outputSchemaViolation).map((r) => r.name)
  );
  const crashes = fuzz.filter((r) => r.outcome === "protocolCrash").length;

  if (
    silentTools.size === 0 &&
    emptyTools.size === 0 &&
    schemaTools.size === 0 &&
    crashes === 0
  ) {
    return "**✓ No critical behavioral issues** — no silent accepts, hallucinated successes, output-schema violations or protocol crashes";
  }

  const parts: string[] = [];
  if (silentTools.size > 0) {
    // List the offending tools when there are only a few; otherwise the count.
    const names =
      silentTools.size <= 4 ? ` (${[...silentTools].join(", ")})` : "";
    parts.push(
      `${silentTools.size} tool(s) silently accept malformed input${names}`
    );
  }
  if (emptyTools.size > 0) {
    const names = emptyTools.size <= 4 ? ` (${[...emptyTools].join(", ")})` : "";
    parts.push(
      `${emptyTools.size} tool(s) return an empty success on valid input — possible hallucinated success${names}`
    );
  }
  if (schemaTools.size > 0) {
    const names = schemaTools.size <= 4 ? ` (${[...schemaTools].join(", ")})` : "";
    parts.push(
      `${schemaTools.size} tool(s) return a success that violates their declared outputSchema${names}`
    );
  }
  if (crashes > 0) {
    parts.push(`${crashes} protocol crash(es)`);
  }
  return `**⚠ Critical:** ${parts.join("; ")}`;
}

function renderDimensions(report: ConformanceReport): string {
  const lines: string[] = [];
  lines.push(`## Dimensions`);
  lines.push("");

  for (const d of report.dimensions) {
    lines.push(renderDimension(d));
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function renderDimension(d: ConformanceReport["dimensions"][number]): string {
  const lines: string[] = [];

  if (d.notMeasured) {
    lines.push(`### ${d.label}: not measured`);

    for (const r of d.reasons) {
      lines.push(`- ${r}`);
    }

    return lines.join("\n");
  }

  lines.push(`### ${d.label}: ${formatScore(d.score)} / 10`);

  for (const r of d.reasons) {
    // Bullet; sub-bullets (lines starting with two spaces) are
    // preserved as-is so the call site can indent follow-up lines.
    lines.push(`- ${r}`);
  }

  return lines.join("\n");
}

function renderFindingsSummary(findings: Finding[]): string {
  const lines: string[] = [];

  lines.push(`## Findings summary`);
  lines.push("");

  if (findings.length === 0) {
    lines.push(
      "No lint findings — every tool's schema passes the conformance rules."
    );
    return lines.join("\n");
  }

  const bySeverity = countBy(findings.map((f) => f.severity));

  lines.push(
    `${findings.length} finding(s): ${bySeverity.error ?? 0} error, ${bySeverity.warning ?? 0} warning, ${bySeverity.info ?? 0} info`
  );

  lines.push("");

  // Sort: errors first, then warnings, then info; then by code
  // alphabetically within each severity. Stable across runs.
  const sorted = [...findings].sort((a, b) => {
    const oa = FINDING_SEVERITY_ORDER[a.severity] ?? 99;
    const ob = FINDING_SEVERITY_ORDER[b.severity] ?? 99;

    if (oa !== ob) return oa - ob;
    if (a.code !== b.code) return a.code.localeCompare(b.code);

    const at = a.location.tool ?? "";
    const bt = b.location.tool ?? "";

    if (at !== bt) return at.localeCompare(bt);

    const ap = a.location.param ?? "";
    const bp = b.location.param ?? "";

    return ap.localeCompare(bp);
  });

  for (const f of sorted) {
    lines.push(formatFinding(f));
  }

  return lines.join("\n");
}

function renderFuzzTable(fuzz: ConformanceReport["fuzz"]): string {
  const lines: string[] = [];

  lines.push(`## Fuzz table`);
  lines.push("");

  if (fuzz.length === 0) {
    lines.push(
      "No fuzz cases ran. Pass `fuzz: true` to evaluate Error Handling and Liveness."
    );
    return lines.join("\n");
  }

  // Header + separator (GitHub-flavored Markdown).
  lines.push("| Tool | Case | Outcome | Silent | Latency (ms) | Notes |");
  lines.push("| --- | --- | --- | --- | --- | --- |");

  for (const r of fuzz) {
    lines.push(formatFuzzRow(r));
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Row formatters
// ---------------------------------------------------------------------------

function formatFinding(f: Finding): string {
  const where = f.location.param
    ? `\`${f.location.tool ?? "?"}.${f.location.param}\``
    : f.location.tool
      ? `\`${f.location.tool}\``
      : "(server-wide)";

  return `- **${f.severity}** \`${f.code}\` on ${where} — ${f.message}`;
}

function formatFuzzRow(r: ConformanceReport["fuzz"][number]): string {
  const silent = r.silentlyAccepted ? "yes" : "no";

  let note = "";

  if (r.outcome === "toolError" && r.errorMessage) {
    note = truncate(r.errorMessage, 60);
  } else if (r.outcome === "protocolCrash" && r.errorMessage) {
    note = `crash: ${truncate(r.errorMessage, 50)}`;
  } else if (r.outputSchemaViolation) {
    note = `outputSchema: ${truncate(r.outputSchemaError ?? "violation", 45)}`;
  } else if (r.emptySuccess) {
    note = "empty success — no content returned";
  }

  return `| \`${r.name}\` | \`${r.case}\` | ${r.outcome} | ${silent} | ${r.latencyMs.toFixed(0)} | ${escapePipes(note)} |`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a 0..10 dimension score with up to 2 decimal places. */
function formatScore(n: number): string {
  return n.toFixed(2).replace(/\.?0+$/, "");
}

function countBy(items: string[]): Record<string, number> {
  const out: Record<string, number> = {};

  for (const x of items) {
    out[x] = (out[x] ?? 0) + 1;
  }

  return out;
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();

  if (flat.length <= n) {
    return flat;
  }

  return flat.slice(0, n - 1) + "…";
}

/** Escape Markdown table-breaking characters. */
function escapePipes(s: string): string {
  return s
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\|/g, "\\|");
}
