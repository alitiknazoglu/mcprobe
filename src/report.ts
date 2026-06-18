// Pure Markdown report renderer. Takes a fully-populated
// ConformanceReport and returns a single Markdown string with the
// sections required by AC-6: overall score, letter grade, four
// per-dimension lines (each with a score and a concrete reason list),
// a findings summary, and a fuzz table.
//
// The renderer is intentionally pure: no I/O, no clock, no global
// state. That makes it trivial to unit-test and guarantees the
// output is stable across runs.

import type { ConformanceReport, Finding } from "./types.js";

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
  return parts.join("\n\n") + "\n";
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
  return lines.join("\n");
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
