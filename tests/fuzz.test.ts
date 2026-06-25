// Unit tests for src/fuzz.ts — the case generator.
//
// The contract under test (per spec §4.3):
//   generateCases(schema) returns at least one `valid` case and at
//   least three malformed cases per primitive schema type. The
//   malformed cases cover `missing_required`, `wrong_type`,
//   `out_of_enum`, and `extra_garbage` (or the no-schema trio when
//   the input has no usable schema).
//
// We test the pure case generator here; the runner is exercised by
// the smoke scripts (smoke-fuzz.mjs, smoke-report.mjs) so we don't
// pay the live-MCP cost in unit tests.

import { describe, it, expect } from "vitest";
import {
  GARBAGE_KEY,
  generateCases,
  sampleValidValue,
  summarizeFuzz,
  type CallFn,
  runOneCaseForTest,
  runFuzz,
  isDestructive,
} from "../src/fuzz.js";
import type { FuzzCase, FuzzResult, ToolSummary } from "../src/types.js";
import type { Connection } from "../src/target-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function labels(cases: FuzzCase[]): string[] {
  return cases.map((c) => c.label);
}

function malformed(cases: FuzzCase[]): FuzzCase[] {
  return cases.filter((c) => c.malformed);
}

function validCase(cases: FuzzCase[]): FuzzCase | undefined {
  return cases.find((c) => !c.malformed);
}

// ---------------------------------------------------------------------------
// Per-primitive: 1 valid + ≥3 malformed
// ---------------------------------------------------------------------------

describe("fuzz — per-primitive case shape", () => {
  const PRIMITIVES: Array<{
    name: string;
    type: string;
  }> = [
    { name: "string", type: "string" },
    { name: "number", type: "number" },
    { name: "integer", type: "integer" },
    { name: "boolean", type: "boolean" },
    { name: "array", type: "array" },
    { name: "object", type: "object" },
    { name: "null", type: "null" },
  ];

  for (const p of PRIMITIVES) {
    it(`primitive=${p.name}: emits 1 valid + at least 3 malformed cases`, () => {
      const schema = {
        type: "object",
        properties: {
          x: { type: p.type, description: `a ${p.name} value` },
        },
        required: ["x"],
      };
      const cases = generateCases(schema);
      const v = validCase(cases);
      expect(v).toBeDefined();
      expect(v?.args).toHaveProperty("x");
      // The valid case must NOT be marked malformed.
      expect(v?.malformed).toBe(false);

      // We need at least three malformed categories. The generator's
      // minimum for a typed+required+described prop is:
      //   - missing_required:x
      //   - wrong_type:x
      //   - extra_garbage
      //   (= 3). When the prop also has an enum/const, out_of_enum
      //   adds one more. We assert >= 3 (the spec's floor).
      const bad = malformed(cases);
      expect(bad.length).toBeGreaterThanOrEqual(3);

      // The three categories we expect, by label prefix.
      const badLabels = labels(bad);
      expect(badLabels.some((l) => l.startsWith("missing_required:"))).toBe(true);
      expect(badLabels.some((l) => l.startsWith("wrong_type:"))).toBe(true);
      expect(badLabels.some((l) => l === "extra_garbage")).toBe(true);
    });
  }

  it("primitive: extra_garbage case always carries the GARBAGE_KEY on top of valid args", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    };
    const cases = generateCases(schema);
    const garbage = cases.find((c) => c.label === "extra_garbage");
    expect(garbage).toBeDefined();
    expect(garbage?.malformed).toBe(true);
    expect(garbage?.args).toHaveProperty(GARBAGE_KEY, true);
    // The original valid args are preserved alongside the garbage.
    expect(garbage?.args).toHaveProperty("a");
  });

  it("primitive: wrong_type for a string prop sends a number", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    };
    const cases = generateCases(schema);
    const wt = cases.find((c) => c.label === "wrong_type:a");
    expect(wt).toBeDefined();
    expect(wt?.args.a).toBe(123); // number, not string
  });

  it("primitive: wrong_type for a number prop sends a string", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "number" } },
      required: ["a"],
    };
    const cases = generateCases(schema);
    const wt = cases.find((c) => c.label === "wrong_type:a");
    expect(wt?.args.a).toBe("not a number");
  });

  it("primitive: wrong_type for a boolean prop sends a string", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "boolean" } },
      required: ["a"],
    };
    const cases = generateCases(schema);
    const wt = cases.find((c) => c.label === "wrong_type:a");
    expect(wt?.args.a).toBe("not a boolean");
  });

  it("primitive: wrong_type is omitted when the prop is untyped", () => {
    // Untyped props can't generate a "wrong type" (no type to deviate
    // from); the generator skips wrong_type but still emits the
    // other malformed categories.
    const schema = {
      type: "object",
      properties: { a: { description: "no type" } },
      required: ["a"],
    };
    const cases = generateCases(schema);
    expect(cases.find((c) => c.label === "wrong_type:a")).toBeUndefined();
    expect(cases.find((c) => c.label === "missing_required:a")).toBeDefined();
    expect(cases.find((c) => c.label === "extra_garbage")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Enum + const variants
// ---------------------------------------------------------------------------

describe("fuzz — enum and const variants", () => {
  it("emits out_of_enum for every enum property", () => {
    const schema = {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["fast", "safe", "verbose"] },
      },
      required: ["mode"],
    };
    const cases = generateCases(schema);
    const oe = cases.find((c) => c.label === "out_of_enum:mode");
    expect(oe).toBeDefined();
    expect(oe?.malformed).toBe(true);
    // The out-of-enum value must NOT be one of the allowed values.
    expect(["fast", "safe", "verbose"]).not.toContain(oe?.args.mode);
  });

  it("emits out_of_enum for a const-typed property (one-value enum)", () => {
    const schema = {
      type: "object",
      properties: {
        kind: { const: "alpha" },
      },
      required: ["kind"],
    };
    const cases = generateCases(schema);
    const oe = cases.find((c) => c.label === "out_of_enum:kind");
    expect(oe).toBeDefined();
    expect(oe?.args.kind).not.toBe("alpha");
  });

  it("emits one missing_required case per required field", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "string" },
        c: { type: "string" },
      },
      required: ["a", "b", "c"],
    };
    const cases = generateCases(schema);
    expect(cases.find((c) => c.label === "missing_required:a")).toBeDefined();
    expect(cases.find((c) => c.label === "missing_required:b")).toBeDefined();
    expect(cases.find((c) => c.label === "missing_required:c")).toBeDefined();
    // The valid case has all three.
    const v = validCase(cases);
    expect(v?.args).toHaveProperty("a");
    expect(v?.args).toHaveProperty("b");
    expect(v?.args).toHaveProperty("c");
  });
});

// ---------------------------------------------------------------------------
// No-schema fallback
// ---------------------------------------------------------------------------

describe("fuzz — no-schema trio", () => {
  it("returns a valid + two malformed cases when the schema is empty", () => {
    const cases = generateCases({});
    expect(cases.length).toBe(3);
    expect(validCase(cases)).toBeDefined();
    expect(cases.find((c) => c.label === "empty_args")).toBeDefined();
    expect(cases.find((c) => c.label === "extra_garbage")).toBeDefined();
  });

  it("returns a valid + two malformed cases when the schema is null/undefined", () => {
    for (const s of [null, undefined]) {
      const cases = generateCases(s as unknown);
      expect(cases.length).toBe(3);
      expect(validCase(cases)).toBeDefined();
      expect(cases.find((c) => c.label === "extra_garbage")).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// sampleValidValue — for unknown types, returns null
// ---------------------------------------------------------------------------

describe("fuzz — sampleValidValue", () => {
  it("returns the first enum value when the prop has an enum", () => {
    expect(sampleValidValue({ enum: ["x", "y", "z"] }, "p")).toBe("x");
  });

  it("returns the const value when the prop has a const", () => {
    expect(sampleValidValue({ const: 42 }, "p")).toBe(42);
  });

  it("returns a typed primitive for type=string", () => {
    expect(sampleValidValue({ type: "string" }, "p")).toBe("mcprobe-p");
  });

  it("returns 1 for type=number/integer", () => {
    expect(sampleValidValue({ type: "number" }, "p")).toBe(1);
    expect(sampleValidValue({ type: "integer" }, "p")).toBe(1);
  });

  it("returns true for type=boolean", () => {
    expect(sampleValidValue({ type: "boolean" }, "p")).toBe(true);
  });

  it("returns null for an untyped prop (neutral value)", () => {
    expect(sampleValidValue({ description: "no type" }, "p")).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// runOneCaseForTest — outcome classification
// ---------------------------------------------------------------------------

describe("fuzz — runOneCaseForTest outcome classification", () => {
  const baseCall =
    (behavior: (
      | "ok"
      | "isError"
      | "throw"
    )): CallFn =>
    async (_name, _args) => {
      if (behavior === "throw") {
        throw new Error("synthetic protocol crash");
      }
      return {
        // After the throw above, behavior is narrowed to "ok"|"isError",
        // so ok is always true here.
        ok: true,
        isError: behavior === "isError",
        content: [{ type: "text", text: "synthetic" }],
        latencyMs: 1,
        error: behavior === "isError" ? "synthetic" : undefined,
      };
    };

  it("classifies ok && !isError on a valid case as outcome=ok, silent=false", async () => {
    const r = await runOneCaseForTest(baseCall("ok"), "t", {
      label: "valid",
      args: {},
      malformed: false,
    });
    expect(r.outcome).toBe("ok");
    expect(r.silentlyAccepted).toBe(false);
    expect(r.name).toBe("t");
  });

  it("classifies ok && !isError on a MALFORMED case as silentlyAccepted=true", async () => {
    const r = await runOneCaseForTest(baseCall("ok"), "t", {
      label: "extra_garbage",
      args: { __mcprobe_garbage__: true },
      malformed: true,
    });
    expect(r.outcome).toBe("ok");
    expect(r.silentlyAccepted).toBe(true);
  });

  it("classifies ok && isError on a malformed case as toolError (graceful)", async () => {
    const r = await runOneCaseForTest(baseCall("isError"), "t", {
      label: "wrong_type:x",
      args: { x: 123 },
      malformed: true,
    });
    expect(r.outcome).toBe("toolError");
    expect(r.silentlyAccepted).toBe(false);
    expect(r.errorMessage).toBe("synthetic");
  });

  it("classifies ok=false (caught transport error) as protocolCrash", async () => {
    const call: CallFn = async () => ({
      ok: false,
      isError: true,
      content: [],
      error: "transport-level failure",
      latencyMs: 5,
    });
    const r = await runOneCaseForTest(call, "t", {
      label: "valid",
      args: {},
      malformed: false,
    });
    expect(r.outcome).toBe("protocolCrash");
  });

  it("classifies a thrown error as protocolCrash", async () => {
    const r = await runOneCaseForTest(baseCall("throw"), "t", {
      label: "valid",
      args: {},
      malformed: false,
    });
    expect(r.outcome).toBe("protocolCrash");
    expect(r.errorMessage).toMatch(/synthetic protocol crash/);
  });
});

// ---------------------------------------------------------------------------
// summarizeFuzz — histogram consistency
// ---------------------------------------------------------------------------

describe("fuzz — summarizeFuzz", () => {
  function makeRow(
    name: string,
    caseName: string,
    outcome: FuzzResult["outcome"],
    silent: boolean
  ): FuzzResult {
    return {
      name,
      case: caseName,
      outcome,
      silentlyAccepted: silent,
      latencyMs: 1,
    };
  }

  it("totals match the input length", () => {
    const rows: FuzzResult[] = [
      makeRow("a", "valid", "ok", false),
      makeRow("a", "extra_garbage", "ok", true),
      makeRow("b", "valid", "toolError", false),
      makeRow("b", "missing_required:x", "protocolCrash", false),
    ];
    const s = summarizeFuzz(rows);
    expect(s.total).toBe(4);
    expect(s.ok + s.toolError + s.protocolCrash).toBe(s.total);
    expect(s.silentlyAccepted).toBe(1);
  });

  it("per-tool breakdown sums to the global total", () => {
    const rows: FuzzResult[] = [
      makeRow("a", "valid", "ok", false),
      makeRow("a", "extra_garbage", "ok", true),
      makeRow("b", "valid", "ok", false),
      makeRow("b", "extra_garbage", "ok", true),
    ];
    const s = summarizeFuzz(rows);
    const perToolTotal = s.perTool.reduce((acc, p) => acc + p.total, 0);
    expect(perToolTotal).toBe(s.total);
  });
});

// ---------------------------------------------------------------------------
// runFuzz — dry-run safety + coverage (Features 1 & 2)
// ---------------------------------------------------------------------------

const SIMPLE_SCHEMA = {
  type: "object",
  properties: { x: { type: "string", description: "an arg" } },
  required: ["x"],
};

function tool(name: string, annotations?: Record<string, unknown>): ToolSummary {
  return { name, description: "a tool", inputSchema: SIMPLE_SCHEMA, annotations };
}

/** A fake connection — never dereferenced because we always pass options.call. */
const FAKE_CONN = {} as unknown as Connection;

/** A call function that records which tools were invoked and returns ok. */
function recordingCall(): { call: CallFn; calledTools: () => Set<string> } {
  const seen = new Set<string>();
  const call: CallFn = async (name) => {
    seen.add(name);
    return { ok: true, isError: false, content: [], latencyMs: 1 };
  };
  return { call, calledTools: () => seen };
}

describe("isDestructive", () => {
  it("is true only when annotations.destructiveHint === true", () => {
    expect(isDestructive(tool("a", { destructiveHint: true }))).toBe(true);
    expect(isDestructive(tool("b", { destructiveHint: false }))).toBe(false);
    expect(isDestructive(tool("c", { readOnlyHint: true }))).toBe(false);
    expect(isDestructive(tool("d"))).toBe(false);
  });
});

describe("runFuzz — dry-run + coverage", () => {
  it("skips destructive tools by default and records them in coverage", async () => {
    const rec = recordingCall();
    const { results, coverage } = await runFuzz(
      FAKE_CONN,
      [tool("safe"), tool("danger", { destructiveHint: true })],
      { call: rec.call }
    );
    expect(rec.calledTools().has("safe")).toBe(true);
    expect(rec.calledTools().has("danger")).toBe(false);
    expect(coverage.totalTools).toBe(2);
    expect(coverage.fuzzedTools).toBe(1);
    expect(coverage.skippedDestructive).toEqual(["danger"]);
    expect(coverage.skippedOverCap).toEqual([]);
    expect(results.every((r) => r.name === "safe")).toBe(true);
  });

  it("fuzzes destructive tools when fuzzDestructive is true", async () => {
    const rec = recordingCall();
    const { coverage } = await runFuzz(
      FAKE_CONN,
      [tool("safe"), tool("danger", { destructiveHint: true })],
      { call: rec.call, fuzzDestructive: true }
    );
    expect(rec.calledTools().has("danger")).toBe(true);
    expect(coverage.fuzzedTools).toBe(2);
    expect(coverage.skippedDestructive).toEqual([]);
  });

  it("applies the maxTools cap to eligible tools and records the overflow", async () => {
    const rec = recordingCall();
    const { coverage } = await runFuzz(
      FAKE_CONN,
      [tool("a"), tool("b"), tool("c")],
      { call: rec.call, maxTools: 2 }
    );
    expect(coverage.fuzzedTools).toBe(2);
    expect(coverage.skippedOverCap).toEqual(["c"]);
    expect(rec.calledTools().has("c")).toBe(false);
  });

  it("reports zero fuzzed tools when every tool is destructive (no opt-in)", async () => {
    const rec = recordingCall();
    const { results, coverage } = await runFuzz(
      FAKE_CONN,
      [tool("d1", { destructiveHint: true }), tool("d2", { destructiveHint: true })],
      { call: rec.call }
    );
    expect(results).toHaveLength(0);
    expect(coverage.fuzzedTools).toBe(0);
    expect(coverage.skippedDestructive).toEqual(["d1", "d2"]);
  });
});
