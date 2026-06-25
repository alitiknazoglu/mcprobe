// Conformance scoring. Pure logic — no I/O. Given a target's
// handshake metadata, the lint findings, and (optionally) the
// behavioral fuzz results, produce a per-dimension scorecard and a
// letter grade.
//
// The model is subtractive: every dimension starts at full marks
// (10.0) and loses points only for concrete, observed problems.
// The overall 0–100 score is the mean of *measured* dimensions —
// when fuzz did not run, the two behavioral dimensions are reported
// as "not measured" and excluded from the average rather than
// penalized with a fake value. This is what lets a static audit
// (lint only) of a clean server still score 100/100.
//
// Grades: A >=90, B >=75, C >=60, D >=40, F <40.

import type {
  ConformanceReport,
  DimensionScore,
  Finding,
  FuzzCoverage,
  FuzzResult,
  Grade,
} from "./types.js";

// ---------------------------------------------------------------------------
// Dimension scores (each 0..10)
// ---------------------------------------------------------------------------

/** Full marks (10) for reporting a non-empty name and version. A
 *  +1 bonus (clamped to 10) is awarded for also exposing
 *  `instructions` — a non-trivial affordance for agents. Reasons
 *  document every concrete observation so the report can be audited
 *  by a human. */
export function scoreMetadata(
  serverInfo: { name: string; version: string; instructions?: string },
  capabilities: Record<string, unknown>
): DimensionScore {
  const reasons: string[] = [];
  let score = 10;

  if (!serverInfo.name || serverInfo.name === "unknown") {
    score -= 4;
    reasons.push("server did not report a name in the initialize handshake");
  } else {
    reasons.push(`server reported name='${serverInfo.name}'`);
  }

  if (!serverInfo.version || serverInfo.version === "unknown") {
    score -= 2;
    reasons.push("server did not report a version in the initialize handshake");
  } else {
    reasons.push(`server reported version='${serverInfo.version}'`);
  }

  // capabilities presence is informational, not graded. We just note it.
  const capKeys = Object.keys(capabilities ?? {});
  if (capKeys.length > 0) {
    reasons.push(
      `server advertised capabilities: ${capKeys.sort().join(", ")}`
    );
  } else {
    reasons.push("server advertised no capabilities (empty object)");
  }

  if (serverInfo.instructions && serverInfo.instructions.trim().length > 0) {
    // Bonus: clamped to 10. Don't record a reason; the bonus speaks.
    score = Math.min(10, score + 1);
    reasons.push("server exposed non-empty 'instructions' (+1 bonus)");
  }

  return clampDim("metadata", "Metadata & Documentation", score, reasons);
}

/** Start at 10; subtract 1 per error, 0.5 per warning, 0.25 per info
 *  across the lint findings. Empty findings list is full marks. */
export function scoreSchemaQuality(findings: Finding[]): DimensionScore {
  const reasons: string[] = [];
  let score = 10;

  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const infos = findings.filter((f) => f.severity === "info").length;

  const deduction = errors * 1 + warnings * 0.5 + infos * 0.25;
  score -= deduction;

  if (findings.length === 0) {
    reasons.push("no lint findings — schemas pass every rule");
  } else {
    reasons.push(
      `deducted ${deduction.toFixed(2)} from ${findings.length} finding(s): ${errors} error, ${warnings} warning, ${infos} info`
    );
    // List the top offenders so the report stays scannable.
    const codes = new Map<string, number>();
    for (const f of findings) {
      codes.set(f.code, (codes.get(f.code) ?? 0) + 1);
    }
    const top = Array.from(codes.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    for (const [code, n] of top) {
      reasons.push(`  ${code}: ${n}`);
    }
  }

  return clampDim("schemaQuality", "Schema Quality", score, reasons);
}

/** Error Handling = how well the server *rejects* bad input, scored as a
 *  rate so it's comparable across servers of different sizes. We look only
 *  at malformed cases (everything except the one "valid" case per tool). A
 *  graceful tool error is a correct rejection (full credit); a silent
 *  accept (garbage let through) or a protocol crash (errored at the wire
 *  instead of rejecting cleanly) are both failures (no credit).
 *
 *  score = 10 × (gracefully-rejected malformed cases / total malformed). */
export function scoreErrorHandling(fuzzResults: FuzzResult[]): DimensionScore {
  const reasons: string[] = [];

  const malformed = fuzzResults.filter((r) => r.case !== "valid");
  let graceful = 0;
  let silent = 0;
  let crashes = 0;
  for (const r of malformed) {
    if (r.silentlyAccepted) silent += 1;
    else if (r.outcome === "protocolCrash") crashes += 1;
    else if (r.outcome === "toolError") graceful += 1;
  }

  let score: number;
  if (malformed.length === 0) {
    score = 10;
    reasons.push("no malformed cases were generated for the fuzzed tools");
  } else {
    const rate = graceful / malformed.length;
    score = 10 * rate;
    reasons.push(
      `${graceful}/${malformed.length} malformed input(s) rejected with a clean tool error (${(rate * 100).toFixed(0)}%)`
    );
    if (silent > 0) {
      reasons.push(
        `${silent} malformed case(s) silently accepted — the tool let bad input through`
      );
    }
    if (crashes > 0) {
      reasons.push(
        `${crashes} malformed case(s) crashed the protocol instead of rejecting gracefully`
      );
    }
    if (silent === 0 && crashes === 0) {
      reasons.push("every malformed input was rejected gracefully");
    }
  }

  return clampDim("errorHandling", "Error Handling", score, reasons);
}

/** Liveness & Performance = how well the server *serves* good input,
 *  scored as a rate so it's comparable across server sizes. We look only
 *  at the one "valid" case per tool — a valid call that errors or crashes
 *  is a bug on the happy path. Latency uses the p50 of the successful
 *  valid calls (the contract is that the happy path should be fast):
 *  0.5 points per 100ms above a 200ms target.
 *
 *  score = 10 × (valid calls that succeeded / valid calls) − latency penalty.
 *
 *  Note: valid-case failures are scored here and *only* here; malformed-case
 *  handling is scored in Error Handling. The two dimensions partition the
 *  fuzz cases by case kind, so no outcome is counted twice. */
export function scoreLiveness(fuzzResults: FuzzResult[]): DimensionScore {
  const reasons: string[] = [];

  const valid = fuzzResults.filter((r) => r.case === "valid");
  let ok = 0;
  let failures = 0;
  const okLatencies: number[] = [];
  for (const r of valid) {
    if (r.outcome === "ok") {
      ok += 1;
      okLatencies.push(r.latencyMs);
    } else {
      failures += 1;
    }
  }

  let score: number;
  if (valid.length === 0) {
    score = 10;
    reasons.push("no valid calls were made");
  } else {
    const rate = ok / valid.length;
    score = 10 * rate;
    reasons.push(
      `${ok}/${valid.length} valid call(s) succeeded (${(rate * 100).toFixed(0)}%)`
    );
    if (failures > 0) {
      reasons.push(
        `${failures} valid call(s) failed on good input (tool error or protocol crash)`
      );
    }
  }

  // Latency penalty on the p50 of the successful valid calls.
  if (okLatencies.length > 0) {
    const sorted = [...okLatencies].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const lower = sorted[mid - 1];
    const upper = sorted[mid];
    const p50: number =
      sorted.length % 2 === 0 && lower !== undefined && upper !== undefined
        ? (lower + upper) / 2
        : (upper ?? lower ?? 0);
    const target = 200;
    const maxLatency = sorted[sorted.length - 1] ?? 0;
    if (p50 > target) {
      const buckets = Math.round((p50 - target) / 100);
      const latencyPenalty = buckets * 0.5;
      score -= latencyPenalty;
      reasons.push(
        `p50 latency on valid calls = ${p50.toFixed(0)}ms (target ${target}ms) → ${latencyPenalty.toFixed(1)} point penalty`
      );
    } else {
      reasons.push(
        `p50 latency on valid calls = ${p50.toFixed(0)}ms (target ${target}ms)`
      );
    }
    reasons.push(
      `valid-call latency max = ${maxLatency.toFixed(0)}ms across ${okLatencies.length} call(s)`
    );
  }

  return clampDim("liveness", "Liveness & Performance", score, reasons);
}

// ---------------------------------------------------------------------------
// Rollup
// ---------------------------------------------------------------------------

/** Roll up the four dimension scores into an overall 0–100 score and
 *  a letter grade. The average is taken over *measured* dimensions
 *  only — unmeasured ones (notMeasured: true) are excluded. */
export function rollup(dimensions: DimensionScore[]): {
  overall: number;
  grade: Grade;
} {
  const measured = dimensions.filter((d) => !d.notMeasured);
  if (measured.length === 0) {
    // Defensive: at least one dimension must be measured (Metadata is
    // always available). If we get here, something is wrong upstream.
    return { overall: 0, grade: "F" };
  }
  const mean = measured.reduce((s, d) => s + d.score, 0) / measured.length;
  const overall = Math.round(mean * 10); // 0..10 mean → 0..100
  return { overall, grade: gradeFromOverall(overall) };
}

/** Letter grade from a 0..100 overall. Spec §7: A ≥90, B ≥75, C ≥60,
 *  D ≥40, F <40. */
export function gradeFromOverall(overall: number): Grade {
  if (overall >= 90) return "A";
  if (overall >= 75) return "B";
  if (overall >= 60) return "C";
  if (overall >= 40) return "D";
  return "F";
}

/** A few callers already have a 0..10 dimension mean; this gives them
 *  the same letter without rolling up. */
export function overallFromScore(mean10: number): number {
  return Math.round(mean10 * 10);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Build a complete ConformanceReport from the audit inputs. Pure
 *  (no I/O): the caller is responsible for running lintTools and
 *  runFuzz and threading the results through. */
export function buildReport(
  server: { name: string; version: string; instructions?: string },
  capabilities: Record<string, unknown>,
  findings: Finding[],
  fuzz: FuzzResult[],
  options: { fuzzMeasured: boolean; coverage?: FuzzCoverage } = {
    fuzzMeasured: true,
  }
): ConformanceReport {
  const metadata = scoreMetadata(server, capabilities);
  const schema = scoreSchemaQuality(findings);

  // Fuzz may have been requested but produced no cases — e.g. after the
  // dry-run skip and maxTools cap, no tools were eligible. The behavioral
  // dimensions can only be measured when at least one case actually ran.
  const fuzzRan = options.fuzzMeasured && fuzz.length > 0;
  const behavioralReason = options.fuzzMeasured
    ? "fuzz ran but no tools were eligible to fuzz (see coverage)"
    : "not measured — pass `fuzz: true` to evaluate this dimension";

  const errorHandling = fuzzRan
    ? scoreErrorHandling(fuzz)
    : notMeasured("errorHandling", "Error Handling", behavioralReason);
  const liveness = fuzzRan
    ? scoreLiveness(fuzz)
    : notMeasured("liveness", "Liveness & Performance", behavioralReason);

  const dimensions = [metadata, schema, errorHandling, liveness];
  const { overall, grade } = rollup(dimensions);

  return {
    server,
    overall,
    grade,
    dimensions,
    findings,
    fuzz,
    coverage: options.coverage,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Clamp a 0..10 dimension score and assemble the DimensionScore
 *  record. Rounding to 2 decimals keeps the report output tidy. */
function clampDim(
  key: DimensionScore["key"],
  label: string,
  score: number,
  reasons: string[]
): DimensionScore {
  const clamped = Math.max(0, Math.min(10, score));
  return {
    key,
    label,
    score: Math.round(clamped * 100) / 100,
    reasons,
    notMeasured: false,
  };
}

/** A placeholder dimension when the dimension wasn't measured
 *  (e.g. behavioral dimensions when fuzz: false). Excluded from the
 *  rollup; reported in the rendered Markdown as "not measured". */
function notMeasured(
  key: DimensionScore["key"],
  label: string,
  reason = "not measured — pass `fuzz: true` to evaluate this dimension"
): DimensionScore {
  return {
    key,
    label,
    score: 0,
    reasons: [reason],
    notMeasured: true,
  };
}
