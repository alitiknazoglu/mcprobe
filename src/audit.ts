// Library entry point for embedding MCProbe in another app (e.g. a web
// backend). This wraps the same pure modules the MCP server uses into a
// single `auditUrl()` call, plus `softenReport()` for a free/paywalled tier.
//
// Web audits are HTTP-only: a caller passes a URL, and we never spawn a
// child process for an untrusted user. Keep this module side-effect-free on
// import (no server boot) so it's safe to import from any backend.

import { connectHttp } from "./target-client.js";
import { lintTools } from "./schema-lint.js";
import { runFuzz } from "./fuzz.js";
import { buildReport } from "./conformance.js";
import { renderReport } from "./report.js";
import type {
  ConformanceReport,
  FuzzResult,
  FuzzCoverage,
  Grade,
} from "./types.js";

export type { ConformanceReport, Grade } from "./types.js";
export { renderReport } from "./report.js";

export interface AuditUrlOptions {
  /** Run the behavioral fuzzer (calls the target's tools). Default false —
   *  a static, read-only audit, which is the safe default for a public box. */
  fuzz?: boolean;
  /** Also fuzz tools annotated destructiveHint:true. Default false. */
  fuzzDestructive?: boolean;
  /** Cap on tools fuzzed. Default 10. */
  maxTools?: number;
}

/**
 * Audit an MCP server reachable over HTTP and return the full conformance
 * report. Opens a connection, lints the tool schemas, optionally fuzzes, then
 * scores — and always closes the connection.
 */
export async function auditUrl(
  url: string,
  opts: AuditUrlOptions = {}
): Promise<ConformanceReport> {
  const conn = await connectHttp({ url });
  try {
    const toolsCapability = Boolean(
      (conn.capabilities as { tools?: unknown }).tools
    );
    const findings = lintTools(conn.tools, toolsCapability);

    let fuzz: FuzzResult[] = [];
    let coverage: FuzzCoverage | undefined;
    if (opts.fuzz) {
      const run = await runFuzz(conn, conn.tools, {
        maxTools: opts.maxTools,
        fuzzDestructive: opts.fuzzDestructive,
      });
      fuzz = run.results;
      coverage = run.coverage;
    }

    return buildReport(
      {
        name: conn.serverInfo.name,
        version: conn.serverInfo.version,
        instructions: conn.serverInfo.instructions,
      },
      conn.capabilities,
      findings,
      fuzz,
      { fuzzMeasured: Boolean(opts.fuzz), coverage }
    );
  } finally {
    try {
      await conn.client.close();
    } catch {
      // best-effort: the transport may already be gone
    }
  }
}

/**
 * The free-tier view of a report. Shows how bad it is (score, grade,
 * coverage, dimension scores, finding counts, critical-issue counts) but
 * withholds the actionable detail (per-dimension reasons, the full findings
 * list, the fuzz table, and the recommended fixes) behind the paywall.
 */
export interface SoftReport {
  server: { name: string; version: string };
  overall: number;
  grade: Grade;
  coverage?: FuzzCoverage;
  /** Per-dimension scores only — reasons are withheld. */
  dimensions: Array<{
    key: string;
    label: string;
    score: number;
    notMeasured: boolean;
  }>;
  /** Finding counts by severity — not the list. */
  findings: { total: number; error: number; warning: number; info: number };
  /** Critical-issue summary — counts only, mirrors the report callout. */
  critical: { measured: boolean; silentTools: number; crashes: number };
  /** Sections withheld until the user unlocks the full report. */
  locked: Array<
    "dimensionReasons" | "findingsList" | "fuzzTable" | "recommendedFixes"
  >;
}

/** Trim a full report down to the free-tier view. Pure. */
export function softenReport(report: ConformanceReport): SoftReport {
  const findings = { total: report.findings.length, error: 0, warning: 0, info: 0 };
  for (const f of report.findings) {
    if (f.severity === "error") findings.error += 1;
    else if (f.severity === "warning") findings.warning += 1;
    else findings.info += 1;
  }

  const silentTools = new Set(
    report.fuzz.filter((r) => r.silentlyAccepted).map((r) => r.name)
  );
  const crashes = report.fuzz.filter((r) => r.outcome === "protocolCrash").length;

  return {
    server: { name: report.server.name, version: report.server.version },
    overall: report.overall,
    grade: report.grade,
    coverage: report.coverage,
    dimensions: report.dimensions.map((d) => ({
      key: d.key,
      label: d.label,
      score: d.score,
      notMeasured: d.notMeasured,
    })),
    findings,
    critical: {
      measured: report.fuzz.length > 0,
      silentTools: silentTools.size,
      crashes,
    },
    locked: ["dimensionReasons", "findingsList", "fuzzTable", "recommendedFixes"],
  };
}
