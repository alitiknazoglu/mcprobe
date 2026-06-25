// Shared types for the MCProbe audit pipeline.
// Pure data shapes only — no I/O lives in this module so the rest of the
// probe can be unit-tested without spinning up an MCP server.

export type Severity = "error" | "warning" | "info";

export type FindingCode =
  | "tool.missing_description"
  | "tool.thin_description"
  | "tool.duplicate_name"
  | "tool.unusual_name"
  | "tool.no_input_schema"
  | "schema.invalid"
  | "schema.root_not_object"
  | "schema.no_required"
  | "param.untyped"
  | "param.missing_description"
  | "tool.no_annotations"
  | "server.no_tools";

export interface FindingLocation {
  tool?: string;
  param?: string;
}

export interface Finding {
  code: FindingCode;
  severity: Severity;
  message: string;
  location: FindingLocation;
  hint: string;
}

export interface ToolSummary {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  /** MCP tool annotations (readOnlyHint, destructiveHint, etc.), if the
   *  target declared any. Absent or empty means none were advertised. */
  annotations?: Record<string, unknown>;
}

export type FuzzOutcome = "ok" | "toolError" | "protocolCrash";

export interface FuzzCase {
  label: string;
  args: Record<string, unknown>;
  malformed: boolean;
}

export interface FuzzResult {
  name: string;
  case: string;
  outcome: FuzzOutcome;
  silentlyAccepted: boolean;
  latencyMs: number;
  errorMessage?: string;
}

/** Which of the target's tools were actually fuzzed, and why some were
 *  skipped. Surfaced in the report so the behavioral score's coverage is
 *  explicit rather than implied. */
export interface FuzzCoverage {
  /** Total tools the target advertises. */
  totalTools: number;
  /** Tools that were actually fuzzed (eligible, within the maxTools cap). */
  fuzzedTools: number;
  /** Tools skipped because they are annotated `destructiveHint: true` and
   *  `fuzzDestructive` was not set (the dry-run safety default). */
  skippedDestructive: string[];
  /** Tools skipped because they fell outside the `maxTools` cap. */
  skippedOverCap: string[];
}

export type Grade = "A" | "B" | "C" | "D" | "F";

export interface DimensionScore {
  key:
    | "metadata"
    | "schemaQuality"
    | "errorHandling"
    | "liveness";
  label: string;
  score: number; // 0..10
  reasons: string[];
  notMeasured: boolean;
}

export interface ConformanceReport {
  server: { name: string; version: string; instructions?: string };
  overall: number; // 0..100
  grade: Grade;
  dimensions: DimensionScore[];
  findings: Finding[];
  fuzz: FuzzResult[];
  /** Present only when fuzzing ran. Describes how many tools were covered. */
  coverage?: FuzzCoverage;
}
