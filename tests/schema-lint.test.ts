// Unit tests for src/schema-lint.ts.
//
// One `it()` per lint rule, each fed a synthetic ToolSummary crafted
// to trip exactly that rule (and ideally no others) so the assertion
// is precise. The 12 codes covered here mirror the FindingCode union
// in src/types.ts, which in turn mirrors the spec section §6.

import { describe, it, expect } from "vitest";
import { lintTools } from "../src/schema-lint.js";
import type { Finding, FindingCode, ToolSummary } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run lintTools and return just the codes (sorted, deduped). */
function codes(findings: Finding[]): FindingCode[] {
  return Array.from(new Set(findings.map((f) => f.code))).sort() as FindingCode[];
}

/** First finding matching the given code, or undefined. */
function findOne(
  findings: Finding[],
  code: FindingCode
): Finding | undefined {
  return findings.find((f) => f.code === code);
}

// A "clean" baseline tool that the per-rule tests reuse and mutate
// to isolate a single rule. Description is full-length, name is
// snake_case, input schema is a valid object with a single typed
// and described property marked required.
const CLEAN_TOOL: ToolSummary = {
  name: "clean_tool",
  description: "A cleanly-described tool with a fully-typed input schema.",
  inputSchema: {
    type: "object",
    properties: {
      arg: {
        type: "string",
        description: "A clearly-described string argument.",
      },
    },
    required: ["arg"],
  },
  annotations: { readOnlyHint: true },
};

// ---------------------------------------------------------------------------
// The 11 lint rules
// ---------------------------------------------------------------------------

describe("schema-lint — 12 lint rules", () => {
  it("rule 1: flags tool.missing_description when description is absent", () => {
    const tool: ToolSummary = { ...CLEAN_TOOL, description: undefined };
    const findings = lintTools([tool], true);
    const f = findOne(findings, "tool.missing_description");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("error");
    expect(f?.location).toEqual({ tool: "clean_tool" });
    expect(f?.message).toMatch(/no description/i);
    expect(f?.hint).toMatch(/description/i);
  });

  it("rule 2: flags tool.thin_description when description is under 12 chars", () => {
    const tool: ToolSummary = { ...CLEAN_TOOL, description: "too short" };
    const findings = lintTools([tool], true);
    const f = findOne(findings, "tool.thin_description");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("warning");
    expect(f?.location).toEqual({ tool: "clean_tool" });
    // The tool should NOT also fire missing_description (description is present)
    expect(findOne(findings, "tool.missing_description")).toBeUndefined();
  });

  it("rule 3: flags tool.duplicate_name when the same name is registered twice", () => {
    const a: ToolSummary = { ...CLEAN_TOOL };
    const b: ToolSummary = { ...CLEAN_TOOL, description: "Different description so we can still see the duplicate." };
    const findings = lintTools([a, b], true);
    const dups = findings.filter((f) => f.code === "tool.duplicate_name");
    expect(dups.length).toBe(2); // one per occurrence
    expect(dups.every((d) => d.severity === "error")).toBe(true);
    expect(dups.every((d) => d.location.tool === "clean_tool")).toBe(true);
    expect(findOne(findings, "tool.missing_description")).toBeUndefined();
  });

  it("rule 4: flags tool.unusual_name when the name is not snake/kebab-case", () => {
    const tool: ToolSummary = { ...CLEAN_TOOL, name: "CamelCaseTool" };
    const findings = lintTools([tool], true);
    const f = findOne(findings, "tool.unusual_name");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("warning");
    expect(f?.location).toEqual({ tool: "CamelCaseTool" });
    expect(f?.message).toMatch(/not snake_case or kebab-case/i);
  });

  it("rule 5: flags tool.no_input_schema when the schema is empty/absent", () => {
    const tool: ToolSummary = { ...CLEAN_TOOL, inputSchema: {} as Record<string, unknown> };
    const findings = lintTools([tool], true);
    const f = findOne(findings, "tool.no_input_schema");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("warning");
    expect(f?.location).toEqual({ tool: "clean_tool" });
    // schema.invalid must NOT also fire (empty {} is valid JSON Schema)
    expect(findOne(findings, "schema.invalid")).toBeUndefined();
  });

  it("rule 6: flags schema.invalid when Ajv cannot compile the schema", () => {
    // A $ref to a non-existent definition target fails Ajv compile.
    const tool: ToolSummary = {
      ...CLEAN_TOOL,
      inputSchema: {
        type: "object",
        properties: {
          x: { $ref: "#/definitions/does_not_exist" },
        },
      },
    };
    const findings = lintTools([tool], true);
    const f = findOne(findings, "schema.invalid");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("error");
    expect(f?.message).toMatch(/failed to compile/i);
  });

  it("rule 7: flags schema.root_not_object when the root type is not 'object'", () => {
    const tool: ToolSummary = {
      ...CLEAN_TOOL,
      inputSchema: {
        type: "string",
        // Note: no `properties` because the root is a string.
      },
    };
    const findings = lintTools([tool], true);
    const f = findOne(findings, "schema.root_not_object");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("warning");
    expect(f?.message).toMatch(/root is type='string'/);
  });

  it("rule 8: flags schema.no_required when there are properties but no required", () => {
    const tool: ToolSummary = {
      ...CLEAN_TOOL,
      inputSchema: {
        type: "object",
        properties: {
          arg: { type: "string", description: "present, but not in required[]" },
        },
        // no `required` array
      },
    };
    const findings = lintTools([tool], true);
    const f = findOne(findings, "schema.no_required");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("info");
    expect(f?.message).toMatch(/none are marked required/i);
  });

  it("rule 9: flags param.untyped when a property has no type/enum/const/oneOf", () => {
    const tool: ToolSummary = {
      ...CLEAN_TOOL,
      inputSchema: {
        type: "object",
        properties: {
          arg: { description: "no type, no enum, no const, no oneOf" },
        },
        required: ["arg"],
      },
    };
    const findings = lintTools([tool], true);
    const f = findOne(findings, "param.untyped");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("warning");
    expect(f?.location).toEqual({ tool: "clean_tool", param: "arg" });
    expect(f?.message).toMatch(/no type\/enum\/const\/oneOf/);
  });

  it("rule 10: flags param.missing_description when a property has no description", () => {
    const tool: ToolSummary = {
      ...CLEAN_TOOL,
      inputSchema: {
        type: "object",
        properties: {
          arg: { type: "string" /* no description */ },
        },
        required: ["arg"],
      },
    };
    const findings = lintTools([tool], true);
    const f = findOne(findings, "param.missing_description");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("warning");
    expect(f?.location).toEqual({ tool: "clean_tool", param: "arg" });
    expect(f?.message).toMatch(/no description/i);
  });

  it("rule 11: flags server.no_tools when capabilities advertise tools but the list is empty", () => {
    // No tools; toolsCapability is true (advertised).
    const findings = lintTools([], true);
    const f = findOne(findings, "server.no_tools");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("warning");
    expect(f?.location).toEqual({});
  });

  it("rule 11 (negative): does NOT flag server.no_tools when toolsCapability is false", () => {
    // The server didn't even claim to have tools — silence is fine.
    const findings = lintTools([], false);
    expect(findOne(findings, "server.no_tools")).toBeUndefined();
  });

  it("rule 12: flags tool.no_annotations when a tool declares no annotations", () => {
    const tool: ToolSummary = { ...CLEAN_TOOL, annotations: undefined };
    const findings = lintTools([tool], true);
    const f = findOne(findings, "tool.no_annotations");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("info");
    expect(f?.location).toEqual({ tool: "clean_tool" });
    expect(f?.message).toMatch(/no annotations/i);
    // An otherwise-clean tool trips only this rule.
    expect(findings).toHaveLength(1);
  });

  it("rule 12 (negative): does NOT flag tool.no_annotations when annotations are present", () => {
    // CLEAN_TOOL carries annotations, so the rule must stay silent.
    const findings = lintTools([CLEAN_TOOL], true);
    expect(findOne(findings, "tool.no_annotations")).toBeUndefined();
  });

  it("rule 12: treats an empty annotations object the same as none", () => {
    const tool: ToolSummary = { ...CLEAN_TOOL, annotations: {} };
    const findings = lintTools([tool], true);
    expect(findOne(findings, "tool.no_annotations")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting invariants
// ---------------------------------------------------------------------------

describe("schema-lint — invariants", () => {
  it("clean tool produces zero findings (or only the noise-free minimum)", () => {
    const findings = lintTools([CLEAN_TOOL], true);
    // The clean tool has description, snake_case name, a typed+described
    // required arg. It should produce no findings.
    expect(findings).toEqual([]);
  });

  it("every emitted finding has a code from the 12-rule union", () => {
    const all: ToolSummary[] = [
      { ...CLEAN_TOOL, name: "t1" },
      {
        ...CLEAN_TOOL,
        name: "CamelCase",
        description: undefined,
        inputSchema: { type: "string" },
      },
      {
        ...CLEAN_TOOL,
        name: "t3",
        inputSchema: {
          type: "object",
          properties: { x: { $ref: "#/no" } },
        },
      },
    ];
    const findings = lintTools(all, true);
    const ALLOWED: ReadonlyArray<FindingCode> = [
      "tool.missing_description",
      "tool.thin_description",
      "tool.duplicate_name",
      "tool.unusual_name",
      "tool.no_input_schema",
      "schema.invalid",
      "schema.root_not_object",
      "schema.no_required",
      "param.untyped",
      "param.missing_description",
      "tool.no_annotations",
      "server.no_tools",
    ];
    for (const f of findings) {
      expect(ALLOWED).toContain(f.code);
    }
  });

  it("every finding has the five stable fields populated", () => {
    const all: ToolSummary[] = [
      { ...CLEAN_TOOL, name: "t1", description: undefined },
      {
        ...CLEAN_TOOL,
        name: "t2",
        inputSchema: { type: "object", properties: { x: {} } },
      },
    ];
    const findings = lintTools(all, true);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(typeof f.code).toBe("string");
      expect(f.code.length).toBeGreaterThan(0);
      expect(["error", "warning", "info"]).toContain(f.severity);
      expect(typeof f.message).toBe("string");
      expect(f.message.length).toBeGreaterThan(0);
      expect(typeof f.hint).toBe("string");
      expect(f.hint.length).toBeGreaterThan(0);
      expect(typeof f.location).toBe("object");
    }
  });

  it("the well-behaved test tool produces no param.untyped finding", () => {
    // This mirrors the AC-4 smoke assertion, in unit form.
    const findings = lintTools([CLEAN_TOOL], true);
    expect(codes(findings)).not.toContain("param.untyped");
  });
});
