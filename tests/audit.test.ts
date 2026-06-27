// Unit tests for the library entry (src/audit.ts). auditUrl() needs a live
// HTTP target so it's exercised manually / by the app; softenReport() is pure
// and is the free-tier paywall boundary, so it's pinned here.

import { describe, it, expect } from "vitest";
import { softenReport } from "../src/audit.js";
import { buildReport } from "../src/conformance.js";
import type { Finding, FuzzResult } from "../src/types.js";

describe("softenReport", () => {
  const findings: Finding[] = [
    { code: "tool.missing_description", severity: "error", message: "m", location: { tool: "t" }, hint: "h" },
    { code: "param.untyped", severity: "warning", message: "m", location: { tool: "t", param: "x" }, hint: "h" },
  ];
  const fuzz: FuzzResult[] = [
    { name: "t", case: "wrong_type:x", outcome: "ok", silentlyAccepted: true, latencyMs: 1 },
    { name: "t", case: "valid", outcome: "ok", silentlyAccepted: false, latencyMs: 1 },
  ];
  const report = buildReport(
    { name: "s", version: "1.0.0" },
    { tools: {} },
    findings,
    fuzz,
    { fuzzMeasured: true, coverage: { totalTools: 1, fuzzedTools: 1, skippedDestructive: [], skippedOverCap: [] } }
  );

  it("keeps the headline numbers (score, grade, dimension scores)", () => {
    const soft = softenReport(report);
    expect(soft.overall).toBe(report.overall);
    expect(soft.grade).toBe(report.grade);
    expect(soft.dimensions).toHaveLength(4);
    expect(soft.dimensions[0]).toMatchObject({ key: "metadata", score: expect.any(Number) });
  });

  it("reports finding and critical counts, not the lists", () => {
    const soft = softenReport(report);
    expect(soft.findings).toEqual({ total: 2, error: 1, warning: 1, info: 0 });
    expect(soft.critical).toEqual({ measured: true, silentTools: 1, crashes: 0 });
  });

  it("withholds the paid detail (no reasons, locked sections listed)", () => {
    const soft = softenReport(report);
    for (const d of soft.dimensions) {
      expect(d).not.toHaveProperty("reasons");
    }
    expect(soft.locked).toEqual([
      "dimensionReasons",
      "findingsList",
      "fuzzTable",
      "recommendedFixes",
    ]);
  });
});
