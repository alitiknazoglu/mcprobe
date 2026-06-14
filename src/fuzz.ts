// Behavioral fuzzing pipeline. Pure case-generation logic plus a thin
// runner that classifies per-call outcomes against a real target.
//
// The fuzzer's job is to be the hero feature: actually call the target's
// tools with deliberately broken inputs and watch what the server does.
// The interesting outcomes are:
//   - "toolError"        — the target returned isError: true (graceful rejection).
//   - "protocolCrash"    — the call rejected / the transport closed (worst case).
//   - "silentlyAccepted" — a malformed case came back with isError: false
//                          and any content. The tool just shrugged. Bad.
//
// generateCases is a pure function over the tool's inputSchema so the
// AC-9 vitest suite can exercise it without spinning up a target. The
// runner takes a caller-supplied call function (defaults to target-client
// callTool) so it stays unit-testable against an in-memory fake.

import type { ToolSummary, FuzzCase, FuzzResult, FuzzOutcome } from "./types.js";
import type { CallToolResult } from "./target-client.js";
import { callTool as defaultCallTool } from "./target-client.js";
import type { Connection } from "./target-client.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A function the runner uses to invoke a target tool. Defaults to the
 *  connection's MCP client, but tests can substitute an in-memory fake. */
export type CallFn = (
  name: string,
  args: Record<string, unknown>
) => Promise<CallToolResult>;

export interface RunFuzzOptions {
  /** Cap on the number of tools to fuzz. Defaults to 10 (per spec §4.3). */
  maxTools?: number;
  /** Override the call function (used by tests). */
  call?: CallFn;
}

export interface FuzzSummary {
  total: number;
  ok: number;
  toolError: number;
  protocolCrash: number;
  silentlyAccepted: number;
  perTool: Array<{
    name: string;
    total: number;
    ok: number;
    toolError: number;
    protocolCrash: number;
    silentlyAccepted: number;
  }>;
}

// ---------------------------------------------------------------------------
// Case generator (pure)
// ---------------------------------------------------------------------------

/** Key used for the extra-garbage case. Picked to be obvious in any
 *  server log or error message. */
export const GARBAGE_KEY = "__mcprobe_garbage__";

/** Generate one valid and several malformed inputs from a tool's
 *  inputSchema. Pure: no I/O, no side effects, deterministic for a
 *  given schema.
 *
 *  Guarantees per spec §4.3 and §5:
 *    - exactly one `valid` case (args conform to the schema);
 *    - for every required field, a `missing_required:<name>` case;
 *    - for every typed property, a `wrong_type:<name>` case;
 *    - for every enum/const property, an `out_of_enum:<name>` case;
 *    - one `extra_garbage` case (valid args plus the garbage key);
 *    - tools with no schema get a degenerate trio so fuzz is still
 *      useful against opaque targets.
 *
 *  Edge cases:
 *    - properties without a recognized `type` are still exercised via
 *      `extra_garbage` (the type-agnostic probe);
 *    - if the schema is empty/missing, we fall back to the no-schema
 *      trio as the spec dictates. */
export function generateCases(schema: unknown): FuzzCase[] {
  const s = (schema ?? {}) as Record<string, unknown>;

  // No usable schema → spec says send {} and {__mcprobe_garbage__: x}
  // and treat both as malformed. We also add a "valid" case (still {})
  // for parity with the typed path, even though there's nothing to
  // validate against.
  if (!isUsableObjectSchema(s)) {
    return [
      { label: "valid", args: {}, malformed: false },
      { label: "empty_args", args: {}, malformed: true },
      { label: "extra_garbage", args: { [GARBAGE_KEY]: "x" }, malformed: true },
    ];
  }

  const props = (s.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(s.required) ? (s.required as string[]) : [];
  const propNames = Object.keys(props);

  // (1) The "valid" baseline: populate every property with a value that
  //     satisfies its schema (or null as a neutral for untyped props).
  const validArgs: Record<string, unknown> = {};
  for (const name of propNames) {
    validArgs[name] = sampleValidValue(props[name], name);
  }

  const cases: FuzzCase[] = [
    { label: "valid", args: validArgs, malformed: false },
  ];

  // (2) missing_required — drop each required field one at a time.
  for (const req of required) {
    const args: Record<string, unknown> = {};
    for (const name of propNames) {
      if (name !== req) {
        args[name] = sampleValidValue(props[name], name);
      }
    }
    cases.push({
      label: `missing_required:${req}`,
      args,
      malformed: true,
    });
  }

  // (3) wrong_type — for each typed property, send a value of a
  //     different primitive type. Untyped properties are skipped here
  //     (no clear "wrong type" to send) but still appear via
  //     extra_garbage below.
  for (const [propName, propSchemaRaw] of Object.entries(props)) {
    const propSchema = (propSchemaRaw ?? {}) as Record<string, unknown>;
    const wrongValue = sampleWrongType(propSchema);
    if (wrongValue === undefined) continue;
    const args: Record<string, unknown> = { ...validArgs };
    args[propName] = wrongValue;
    cases.push({
      label: `wrong_type:${propName}`,
      args,
      malformed: true,
    });
  }

  // (4) out_of_enum — for each enum/const property, send a value
  //     deliberately outside the allowed set. A `const` is just a
  //     one-value enum for this purpose.
  for (const [propName, propSchemaRaw] of Object.entries(props)) {
    const propSchema = (propSchemaRaw ?? {}) as Record<string, unknown>;
    const enumArray = Array.isArray(propSchema.enum)
      ? (propSchema.enum as unknown[])
      : null;
    const allowed =
      enumArray && enumArray.length > 0
        ? enumArray
        : "const" in propSchema
          ? [propSchema.const]
          : null;
    if (!allowed) continue;
    const args: Record<string, unknown> = { ...validArgs };
    args[propName] = makeOutOfEnumValue(allowed);
    cases.push({
      label: `out_of_enum:${propName}`,
      args,
      malformed: true,
    });
  }

  // (5) extra_garbage — append a clearly non-schema key to the valid
  //     args. A well-behaved server should reject this in strict mode
  //     (zod's `.strict()`) or at least log it. The demo target uses
  //     default strip mode so this case is silently accepted — which
  //     is exactly the behavior the fuzzer is meant to surface.
  cases.push({
    label: "extra_garbage",
    args: { ...validArgs, [GARBAGE_KEY]: true },
    malformed: true,
  });

  return cases;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** Run the generated cases against the target and classify each outcome.
 *  Pure orchestration: it does not write to any global state; the
 *  caller (the handler in index.ts) threads the result through
 *  conformance scoring and the report renderer. */
export async function runFuzz(
  connection: Connection,
  tools: ToolSummary[],
  options: RunFuzzOptions = {}
): Promise<FuzzResult[]> {
  const maxTools = options.maxTools ?? 10;
  const call: CallFn = options.call
    ? options.call
    : (name, args) => defaultCallTool(connection, name, args);

  const results: FuzzResult[] = [];
  const targets = tools.slice(0, maxTools);

  for (const tool of targets) {
    const cases = generateCases(tool.inputSchema);
    for (const c of cases) {
      const result = await runOneCase(call, tool.name, c);
      results.push(result);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Run a single fuzz case and translate the SDK result into a stable
 *  FuzzResult row. Kept private — exposed only for the AC-9 unit tests
 *  via runOneCaseForTest below. */
async function runOneCase(
  call: CallFn,
  toolName: string,
  fuzzCase: FuzzCase
): Promise<FuzzResult> {
  try {
    const r = await call(toolName, fuzzCase.args);
    return classify(toolName, fuzzCase, r);
  } catch (err) {
    // The default callTool already catches everything and never throws,
    // but a test-supplied call function may throw. Treat that as a
    // protocol crash.
    return {
      name: toolName,
      case: fuzzCase.label,
      outcome: "protocolCrash",
      silentlyAccepted: false,
      latencyMs: 0,
      errorMessage: (err as Error).message ?? String(err),
    };
  }
}

/** Translate one SDK call result into the fuzzer's outcome vocabulary. */
function classify(
  toolName: string,
  fuzzCase: FuzzCase,
  r: CallToolResult
): FuzzResult {
  // ok: false from the callTool wrapper means the call threw — a
  // transport-level error, not a graceful tool error. Treat as a crash.
  if (!r.ok) {
    return {
      name: toolName,
      case: fuzzCase.label,
      outcome: "protocolCrash",
      silentlyAccepted: false,
      latencyMs: r.latencyMs,
      errorMessage: r.error,
    };
  }
  // ok: true && isError: true → the target returned a clean tool error.
  // For a valid case this is a real bug (a tool failed on good input);
  // for a malformed case this is the correct, graceful behavior.
  if (r.isError) {
    return {
      name: toolName,
      case: fuzzCase.label,
      outcome: "toolError",
      silentlyAccepted: false,
      latencyMs: r.latencyMs,
      errorMessage: extractErrorText(r.content),
    };
  }
  // ok: true && isError: false. If the case was malformed, the target
  // accepted garbage — flag it. If it was valid, the target behaved.
  if (fuzzCase.malformed) {
    return {
      name: toolName,
      case: fuzzCase.label,
      outcome: "ok",
      silentlyAccepted: true,
      latencyMs: r.latencyMs,
    };
  }
  return {
    name: toolName,
    case: fuzzCase.label,
    outcome: "ok",
    silentlyAccepted: false,
    latencyMs: r.latencyMs,
  };
}

/** Pull a human-readable line out of a tool-error content array. */
function extractErrorText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      return (part as { text: string }).text;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Schema-sampling helpers
// ---------------------------------------------------------------------------

/** Best-effort "valid" value for one property. Tries enum, const,
 *  examples, default, then falls back to a type-appropriate primitive
 *  using the schema's `type`. Untyped properties get null as a neutral
 *  value (the case will still be exercised via extra_garbage). */
export function sampleValidValue(
  propSchema: unknown,
  name: string
): unknown {
  const s = (propSchema ?? {}) as Record<string, unknown>;

  if (Array.isArray(s.enum) && (s.enum as unknown[]).length > 0) {
    return (s.enum as unknown[])[0];
  }
  if ("const" in s) {
    return s.const;
  }
  if (Array.isArray(s.examples) && (s.examples as unknown[]).length > 0) {
    return (s.examples as unknown[])[0];
  }
  if (s.default !== undefined) {
    return s.default;
  }

  const t = primaryType(s);
  switch (t) {
    case "string":
      return `mcprobe-${name}`;
    case "number":
    case "integer":
      return 1;
    case "boolean":
      return true;
    case "array":
      return [];
    case "object":
      return {};
    case "null":
      return null;
    default:
      // Untyped property: return null. The malformed variants (extra
      // garbage, missing required) still apply.
      return null;
  }
}

/** Produce a value whose primitive type is intentionally not the
 *  declared type. Returns undefined when the property is untyped — the
 *  generator skips wrong_type in that case. */
function sampleWrongType(propSchema: Record<string, unknown>): unknown {
  const t = primaryType(propSchema);
  switch (t) {
    case "string":
      return 123;
    case "number":
    case "integer":
      return "not a number";
    case "boolean":
      return "not a boolean";
    case "array":
      return "not an array";
    case "object":
      return "not an object";
    case "null":
      return "not null";
    default:
      // Untyped or unknown: skip — we don't know what "wrong" means.
      return undefined;
  }
}

/** Pick a value the enum almost certainly doesn't contain. */
function makeOutOfEnumValue(enumValues: unknown[]): unknown {
  const allStrings = enumValues.every((v) => typeof v === "string");
  const allNumbers = enumValues.every((v) => typeof v === "number");
  if (allStrings) return "__mcprobe_out_of_enum__";
  if (allNumbers) return 999999;
  // Mixed-type enum: fall back to a string sentinel.
  return "__mcprobe_out_of_enum__";
}

/** Resolve a JSON Schema's `type` to a single string (it may be a
 *  string or an array of strings). */
function primaryType(s: Record<string, unknown>): string | undefined {
  const t = s.type;
  if (typeof t === "string" && t.length > 0) return t;
  if (Array.isArray(t) && typeof t[0] === "string" && t[0].length > 0) {
    return t[0];
  }
  return undefined;
}

/** True when the schema looks like a JSON Schema object root we can
 *  usefully fuzz (i.e. has either `type` or `properties`). */
function isUsableObjectSchema(s: Record<string, unknown>): boolean {
  if (!s || typeof s !== "object") return false;
  if (Object.keys(s).length === 0) return false;
  const t = primaryType(s);
  if (t === "object") return true;
  if (s.properties && typeof s.properties === "object") return true;
  return false;
}

// ---------------------------------------------------------------------------
// Summarization
// ---------------------------------------------------------------------------

/** Outcome counts for a single tool, plus a total. */
interface PerToolRow {
  ok: number;
  toolError: number;
  protocolCrash: number;
  silentlyAccepted: number;
  total: number;
}

/** Outcome counts across every tool (no `total` — the caller already
 *  knows the total as `results.length`). */
type GlobalCounts = Omit<PerToolRow, "total">;

const emptyRow = (): PerToolRow => ({
  ok: 0,
  toolError: 0,
  protocolCrash: 0,
  silentlyAccepted: 0,
  total: 0,
});

/** Bump a single row in place. The case-label/outcome math lives
 *  here so the loop in summarizeFuzz is just a sequence of bumps. */
function bumpRow(row: PerToolRow, r: FuzzResult): void {
  row.total += 1;
  if (r.outcome === "ok") row.ok += 1;
  else if (r.outcome === "toolError") row.toolError += 1;
  else row.protocolCrash += 1;
  if (r.silentlyAccepted) row.silentlyAccepted += 1;
}

/** Aggregate a list of FuzzResult rows into a small histogram the
 *  handler can return. Per-tool rows make the AC-5 smoke assertions
 *  simple to write; the global counts are the sum of the per-tool
 *  rows, so there is one source of truth. */
export function summarizeFuzz(results: FuzzResult[]): FuzzSummary {
  const perToolMap = new Map<string, PerToolRow>();
  for (const r of results) {
    let row = perToolMap.get(r.name);
    if (!row) {
      row = emptyRow();
      perToolMap.set(r.name, row);
    }
    bumpRow(row, r);
  }

  const totals: GlobalCounts = { ok: 0, toolError: 0, protocolCrash: 0, silentlyAccepted: 0 };
  for (const row of perToolMap.values()) {
    totals.ok += row.ok;
    totals.toolError += row.toolError;
    totals.protocolCrash += row.protocolCrash;
    totals.silentlyAccepted += row.silentlyAccepted;
  }

  return {
    total: results.length,
    ...totals,
    perTool: Array.from(perToolMap.entries()).map(([name, v]) => ({
      name,
      ...v,
    })),
  };
}

/** Expose the private case-runner for the AC-9 vitest suite. Tests
 *  want to feed in a fake CallFn and assert the per-case
 *  classification directly. */
export async function runOneCaseForTest(
  call: CallFn,
  toolName: string,
  fuzzCase: FuzzCase
): Promise<FuzzResult> {
  return runOneCase(call, toolName, fuzzCase);
}

// Re-export the FuzzOutcome type so the index.ts handler can refer to
// it via the fuzz module without digging into types.ts.
export type { FuzzOutcome };
