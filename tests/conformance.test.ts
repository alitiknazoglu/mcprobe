// Unit tests for src/conformance.ts (the 4-dimension scorer) and the
// coverage line rendered by src/report.ts.
//
// Error Handling and Liveness use a normalized, rate-based model and
// partition the fuzz cases by kind: malformed cases score Error Handling,
// valid cases score Liveness. These tests pin both the rates and the
// no-double-count guarantee.

import { describe, it, expect } from "vitest";
import {
  scoreErrorHandling,
  scoreLiveness,
  rollup,
  buildReport,
  gradeFromOverall,
} from "../src/conformance.js";
import { renderReport } from "../src/report.js";
import type {
  FuzzResult,
  FuzzOutcome,
  DimensionScore,
  FuzzCoverage,
} from "../src/types.js";

/** Build a FuzzResult row. `c` is the case label ("valid" or a malformed one). */
function row(
  c: string,
  outcome: FuzzOutcome,
  silent: boolean,
  latencyMs = 1,
  name = "t"
): FuzzResult {
  return { name, case: c, outcome, silentlyAccepted: silent, latencyMs };
}

const malformedGraceful = (n = "t") => row("missing_required:x", "toolError", false, 1, n);
const malformedSilent = (n = "t") => row("wrong_type:x", "ok", true, 1, n);
const malformedCrash = (n = "t") => row("extra_garbage", "protocolCrash", false, 1, n);
const validOk = (ms = 1, n = "t") => row("valid", "ok", false, ms, n);
const validToolError = (n = "t") => row("valid", "toolError", false, 1, n);

// ---------------------------------------------------------------------------
// scoreErrorHandling — graceful-rejection rate over malformed cases
// ---------------------------------------------------------------------------

describe("scoreErrorHandling", () => {
  it("scores 10 when every malformed input is gracefully rejected", () => {
    const d = scoreErrorHandling([malformedGraceful(), malformedGraceful()]);
    expect(d.score).toBe(10);
  });

  it("scores by rate when half are silently accepted", () => {
    const d = scoreErrorHandling([malformedGraceful(), malformedSilent()]);
    expect(d.score).toBe(5); // 1 of 2 gracefully rejected
  });

  it("scores 0 when all malformed inputs are silently accepted", () => {
    const d = scoreErrorHandling([malformedSilent(), malformedSilent()]);
    expect(d.score).toBe(0);
  });

  it("treats a protocol crash on malformed input as a failed rejection", () => {
    const d = scoreErrorHandling([malformedGraceful(), malformedCrash()]);
    expect(d.score).toBe(5); // 1 of 2 rejected gracefully
  });

  it("ignores valid cases entirely (no overlap with Liveness)", () => {
    // One graceful malformed + a broken valid call. Error Handling must see
    // only the malformed case → 1/1 → 10.
    const d = scoreErrorHandling([malformedGraceful(), validToolError()]);
    expect(d.score).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// scoreLiveness — success rate over valid cases + latency
// ---------------------------------------------------------------------------

describe("scoreLiveness", () => {
  it("scores 10 when every valid call succeeds and is fast", () => {
    const d = scoreLiveness([validOk(), validOk()]);
    expect(d.score).toBe(10);
  });

  it("scores by rate when some valid calls fail", () => {
    const d = scoreLiveness([validOk(), validToolError()]);
    expect(d.score).toBe(5); // 1 of 2 valid calls succeeded
  });

  it("ignores malformed cases entirely (no overlap with Error Handling)", () => {
    // One good valid call + a silently-accepted malformed case. Liveness
    // must see only the valid case → 1/1 → 10.
    const d = scoreLiveness([validOk(), malformedSilent()]);
    expect(d.score).toBe(10);
  });

  it("applies a latency penalty above the 200ms target", () => {
    const d = scoreLiveness([validOk(700), validOk(700)]); // p50 700ms → 5 buckets → 2.5
    expect(d.score).toBe(7.5);
  });
});

// ---------------------------------------------------------------------------
// rollup — measured-only mean
// ---------------------------------------------------------------------------

describe("rollup", () => {
  it("averages only measured dimensions", () => {
    const dims: DimensionScore[] = [
      { key: "metadata", label: "Metadata & Documentation", score: 10, reasons: ["x"], notMeasured: false },
      { key: "schemaQuality", label: "Schema Quality", score: 8, reasons: ["x"], notMeasured: false },
      { key: "errorHandling", label: "Error Handling", score: 0, reasons: ["x"], notMeasured: true },
      { key: "liveness", label: "Liveness & Performance", score: 0, reasons: ["x"], notMeasured: true },
    ];
    // mean of measured (10, 8) = 9 → 90
    expect(rollup(dims)).toEqual({ overall: 90, grade: "A" });
  });

  it("maps overall to grades at the documented thresholds", () => {
    expect(gradeFromOverall(90)).toBe("A");
    expect(gradeFromOverall(75)).toBe("B");
    expect(gradeFromOverall(60)).toBe("C");
    expect(gradeFromOverall(40)).toBe("D");
    expect(gradeFromOverall(39)).toBe("F");
  });
});

// ---------------------------------------------------------------------------
// buildReport — coverage storage + dry-run edge case
// ---------------------------------------------------------------------------

const COVERAGE: FuzzCoverage = {
  totalTools: 3,
  fuzzedTools: 2,
  skippedDestructive: ["danger"],
  skippedOverCap: [],
};

describe("buildReport", () => {
  it("stores the fuzz coverage on the report", () => {
    const report = buildReport(
      { name: "s", version: "1.0.0" },
      { tools: {} },
      [],
      [malformedGraceful(), validOk()],
      { fuzzMeasured: true, coverage: COVERAGE }
    );
    expect(report.coverage).toEqual(COVERAGE);
  });

  it("marks behavioral dimensions not-measured when fuzz ran but no cases exist", () => {
    // e.g. every tool was destructive and skipped → empty results.
    const report = buildReport(
      { name: "s", version: "1.0.0" },
      { tools: {} },
      [],
      [],
      { fuzzMeasured: true, coverage: { totalTools: 1, fuzzedTools: 0, skippedDestructive: ["d"], skippedOverCap: [] } }
    );
    const eh = report.dimensions.find((d) => d.key === "errorHandling")!;
    expect(eh.notMeasured).toBe(true);
    expect(eh.reasons[0]).toMatch(/no tools were eligible/i);
  });
});

// ---------------------------------------------------------------------------
// renderReport — coverage line (Feature 2 rendering)
// ---------------------------------------------------------------------------

describe("renderReport coverage line", () => {
  it("renders 'fuzzed N of M' with skip reasons when coverage is present", () => {
    const report = buildReport(
      { name: "s", version: "1.0.0" },
      { tools: {} },
      [],
      [malformedGraceful(), validOk()],
      { fuzzMeasured: true, coverage: COVERAGE }
    );
    const md = renderReport(report);
    expect(md).toMatch(/\*\*Coverage:\*\* fuzzed 2 of 3 tool\(s\)/);
    expect(md).toMatch(/skipped as destructive \(danger\)/);
  });

  it("omits the coverage line for a static audit (no coverage)", () => {
    const report = buildReport(
      { name: "s", version: "1.0.0" },
      { tools: {} },
      [],
      [],
      { fuzzMeasured: false }
    );
    expect(renderReport(report)).not.toMatch(/\*\*Coverage:\*\*/);
  });
});

// ---------------------------------------------------------------------------
// renderReport — critical-issues callout (a flag, not a second score)
// ---------------------------------------------------------------------------

function reportWithFuzz(fuzz: FuzzResult[]) {
  return buildReport(
    { name: "s", version: "1.0.0" },
    { tools: {} },
    [],
    fuzz,
    { fuzzMeasured: true, coverage: COVERAGE }
  );
}

describe("renderReport critical-issues callout", () => {
  it("flags tools that silently accept malformed input, by name", () => {
    const md = renderReport(
      reportWithFuzz([malformedSilent("badTool"), validOk()])
    );
    expect(md).toMatch(/\*\*⚠ Critical:\*\*/);
    expect(md).toMatch(/1 tool\(s\) silently accept malformed input \(badTool\)/);
  });

  it("flags protocol crashes", () => {
    const md = renderReport(reportWithFuzz([malformedCrash(), validOk()]));
    expect(md).toMatch(/1 protocol crash\(es\)/);
  });

  it("shows an all-clear when there are no silent accepts or crashes", () => {
    const md = renderReport(reportWithFuzz([malformedGraceful(), validOk()]));
    expect(md).toMatch(/✓ No critical behavioral issues/);
  });

  it("does not change the score — the callout is purely additive", () => {
    // A silent accept tanks Error Handling but the header still shows the
    // normalized overall/grade; the callout is a separate line.
    const report = reportWithFuzz([malformedSilent(), validOk()]);
    const md = renderReport(report);
    expect(md).toMatch(new RegExp(`\\*\\*Overall score:\\*\\* ${report.overall} / 100`));
  });

  it("omits the callout for a static audit (no fuzz cases)", () => {
    const md = renderReport(
      buildReport({ name: "s", version: "1.0.0" }, { tools: {} }, [], [], {
        fuzzMeasured: false,
      })
    );
    expect(md).not.toMatch(/Critical/);
  });
});
