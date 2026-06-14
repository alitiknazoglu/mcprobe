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

/** Start at 10; subtract 2 per silentlyAccepted malformed case, 4 per
 *  protocolCrash, 1 per toolError on a valid case. Clamp. */
export function scoreErrorHandling(fuzzResults: FuzzResult[]): DimensionScore {
  const reasons: string[] = [];

  let silent = 0;
  let crashes = 0;
  let validToolErrors = 0;

  for (const r of fuzzResults) {
    if (r.silentlyAccepted) silent += 1;
    if (r.outcome === "protocolCrash") crashes += 1;
    if (r.case === "valid" && r.outcome === "toolError") {
      validToolErrors += 1;
    }
  }

  const deduction = silent * 2 + crashes * 4 + validToolErrors * 1;
  let score = 10 - deduction;

  if (fuzzResults.length === 0) {
    reasons.push("no fuzz cases ran (empty result set)");
  } else {
    if (silent > 0) {
      reasons.push(
        `${silent} malformed case(s) were silently accepted (no tool error, no rejection)`
      );
    }
    if (crashes > 0) {
      reasons.push(`${crashes} call(s) crashed the protocol`);
    }
    if (validToolErrors > 0) {
      reasons.push(
        `${validToolErrors} valid case(s) returned a tool error (the tool is broken on good input)`
      );
    }
    if (silent === 0 && crashes === 0 && validToolErrors === 0) {
      reasons.push(
        "every fuzz case behaved correctly (graceful on bad input, clean on valid input)"
      );
    }
    reasons.push(
      `deducted ${deduction} from ${silent + crashes + validToolErrors} behavioral event(s) across ${fuzzResults.length} case(s)`
    );
  }

  return clampDim("errorHandling", "Error Handling", score, reasons);
}

/** Start at 10; subtract 4 per protocolCrash on a valid call, 1 per
 *  toolError on a valid call, 0.5 per 100ms above a 200ms p50 target
 *  (rounded). The latency penalty uses the p50 of the *valid* calls
 *  — the contract is that the happy path should be fast. */
export function scoreLiveness(fuzzResults: FuzzResult[]): DimensionScore {
  const reasons: string[] = [];

  let validCrashes = 0;
  let validToolErrors = 0;
  const validLatencies: number[] = [];
  let maxLatency = 0;

  for (const r of fuzzResults) {
    if (r.latencyMs > maxLatency) maxLatency = r.latencyMs;
    if (r.case === "valid") {
      if (r.outcome === "protocolCrash") validCrashes += 1;
      if (r.outcome === "toolError") validToolErrors += 1;
      if (r.outcome === "ok") validLatencies.push(r.latencyMs);
    }
  }

  let score = 10;
  score -= validCrashes * 4;
  score -= validToolErrors * 1;

  // p50 of valid-call latencies
  if (validLatencies.length > 0) {
    const sorted = [...validLatencies].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const lower = sorted[mid - 1];
    const upper = sorted[mid];
    const p50: number =
      sorted.length % 2 === 0 && lower !== undefined && upper !== undefined
        ? (lower + upper) / 2
        : (upper ?? lower ?? 0);
    const target = 200;
    if (p50 > target) {
      const over = p50 - target;
      const buckets = Math.round(over / 100);
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
      `valid-call latency max = ${maxLatency.toFixed(0)}ms across ${validLatencies.length} call(s)`
    );
  } else {
    reasons.push("no valid-call latencies were collected");
  }

  if (validCrashes > 0) {
    reasons.push(`${validCrashes} valid call(s) crashed the protocol`);
  }
  if (validToolErrors > 0) {
    reasons.push(`${validToolErrors} valid call(s) returned a tool error`);
  }
  if (validCrashes === 0 && validToolErrors === 0 && validLatencies.length > 0) {
    reasons.push("every valid call succeeded with no protocol errors");
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
  options: { fuzzMeasured: boolean } = { fuzzMeasured: true }
): ConformanceReport {
  const metadata = scoreMetadata(server, capabilities);
  const schema = scoreSchemaQuality(findings);

  const errorHandling = options.fuzzMeasured
    ? scoreErrorHandling(fuzz)
    : notMeasured("errorHandling", "Error Handling");
  const liveness = options.fuzzMeasured
    ? scoreLiveness(fuzz)
    : notMeasured("liveness", "Liveness & Performance");

  const dimensions = [metadata, schema, errorHandling, liveness];
  const { overall, grade } = rollup(dimensions);

  return {
    server,
    overall,
    grade,
    dimensions,
    findings,
    fuzz,
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
  label: string
): DimensionScore {
  return {
    key,
    label,
    score: 0,
    reasons: ["not measured — pass `fuzz: true` to evaluate this dimension"],
    notMeasured: true,
  };
}
