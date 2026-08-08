// Schema Quality is a per-tool *rate*, not a running total.
//
// Regression for a real report: a 48-tool server with zero errors scored
// 0/10 purely because every tool contributed one info-level finding
// ("declares no annotations"). The deduction summed while the base stayed at
// 10, so breadth was punished — the identical per-tool quality scored ~8 on a
// 5-tool server. Error Handling and Liveness were already rate-based; these
// tests pin the same property for Schema Quality.

import { describe, it, expect } from "vitest";
import { scoreSchemaQuality } from "../src/conformance.js";
import type { Finding, Severity } from "../src/types.js";

/** N tools, each carrying the same findings — the shape that used to break. */
function findingsForTools(
  toolCount: number,
  per: Array<{ severity: Severity; code: string }>
): Finding[] {
  const out: Finding[] = [];
  for (let i = 0; i < toolCount; i++) {
    for (const f of per) {
      out.push({
        code: f.code as Finding["code"],
        severity: f.severity,
        message: `${f.code} on tool_${i}`,
        location: { tool: `tool_${i}` },
        hint: "fix it",
      });
    }
  }
  return out;
}

const ONE_INFO = [{ severity: "info" as Severity, code: "tool.no_annotations" }];

describe("scoreSchemaQuality is size-independent", () => {
  it("scores the same for 5, 20 and 50 tools with identical per-tool quality", () => {
    const scores = [5, 20, 50].map(
      (n) => scoreSchemaQuality(findingsForTools(n, ONE_INFO), n).score
    );
    expect(new Set(scores).size).toBe(1);
    // One info per tool is a minor nit, not a failing grade.
    expect(scores[0]).toBeGreaterThan(8);
  });

  it("does not bottom out a large, error-free server (the Avalanche case)", () => {
    // 48 tools: every one lacks annotations, 19 also lack `required`,
    // 3 have an undescribed param. Zero errors.
    const findings = [
      ...findingsForTools(48, ONE_INFO),
      ...findingsForTools(19, [
        { severity: "info", code: "schema.no_required" },
      ]),
      ...findingsForTools(3, [
        { severity: "warning", code: "param.missing_description" },
      ]),
    ];
    const { score } = scoreSchemaQuality(findings, 48);
    expect(score).toBeGreaterThan(7); // was 0 under the old absolute model
    expect(score).toBeLessThan(10); // but not a free pass
  });

  it("still punishes genuinely broken schemas regardless of size", () => {
    const broken = [
      { severity: "error" as Severity, code: "tool.missing_description" },
      { severity: "error" as Severity, code: "schema.invalid" },
    ];
    for (const n of [3, 48]) {
      const { score } = scoreSchemaQuality(findingsForTools(n, broken), n);
      expect(score).toBe(0);
    }
  });

  it("gives a clean server full marks", () => {
    const { score, reasons } = scoreSchemaQuality([], 30);
    expect(score).toBe(10);
    expect(reasons.join(" ")).toMatch(/pass every rule/);
  });

  it("counts clean tools — one bad tool among many barely dents the score", () => {
    const findings = findingsForTools(1, [
      { severity: "error", code: "tool.missing_description" },
    ]);
    const small = scoreSchemaQuality(findings, 2).score;
    const large = scoreSchemaQuality(findings, 40).score;
    expect(large).toBeGreaterThan(small);
    expect(large).toBeGreaterThan(9.5);
  });

  it("caps one pathological tool so it can't sink the whole server", () => {
    const manyFindings = Array.from({ length: 40 }, (_, i) => ({
      code: "param.untyped" as Finding["code"],
      severity: "warning" as Severity,
      message: `param ${i}`,
      location: { tool: "kitchen_sink", param: `p${i}` },
      hint: "add a type",
    }));
    const { score } = scoreSchemaQuality(manyFindings, 20);
    // Uncapped this would be 20 points of deduction from a single tool.
    expect(score).toBeGreaterThan(8);
  });

  it("handles a server with no tools without dividing by zero", () => {
    const serverWide: Finding[] = [
      {
        code: "server.no_tools" as Finding["code"],
        severity: "warning",
        message: "server advertises no tools",
        location: {},
        hint: "expose a tool",
      },
    ];
    const { score } = scoreSchemaQuality(serverWide, 0);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeLessThan(10);
  });
});
