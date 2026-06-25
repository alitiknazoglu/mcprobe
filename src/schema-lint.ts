// Schema-lint pipeline. Pure logic — no I/O. Operates on a list of
// ToolSummary records (already cached in the Connection at connect
// time) and returns a Finding[] with stable codes, severities,
// messages, locations, and fix hints.
//
// Rules are implemented as small per-tool functions that return a
// list of findings; the top-level lintTools() composes them in a
// deterministic order so the smoke tests and downstream scoring see
// stable output across runs.

import { Ajv } from "ajv";
import type { Finding, ToolSummary } from "./types.js";

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** Lint the given list of tool summaries and return every finding.
 *  Pure: no I/O, no side effects, deterministic ordering.
 *
 *  @param tools          the cached tool summaries to audit
 *  @param toolsCapability when the server advertises the "tools"
 *                        capability (truthy), the server.no_tools
 *                        rule fires if the list is empty.
 */
export function lintTools(
  tools: ToolSummary[],
  toolsCapability: boolean = true
): Finding[] {
  const findings: Finding[] = [];

  // Server-level rule.
  if (toolsCapability && tools.length === 0) {
    findings.push({
      code: "server.no_tools",
      severity: "warning",
      message: "Server advertises the 'tools' capability but exposes no tools.",
      location: {},
      hint: "Either remove the capability or register at least one tool so agents have something to call.",
    });
  }

  // Detect duplicate names up front so the per-tool pass can flag each.
  const nameCounts = new Map<string, number>();
  for (const t of tools) {
    nameCounts.set(t.name, (nameCounts.get(t.name) ?? 0) + 1);
  }

  // Ajv is reused for the whole batch — strict:false keeps the linter
  // from rejecting modern keywords it doesn't recognize, and allErrors
  // means a single compile call surfaces every issue at once.
  const ajv = makeAjv();

  for (const tool of tools) {
    findings.push(...lintOneTool(tool, nameCounts.get(tool.name) ?? 1, ajv));
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Per-tool pipeline
// ---------------------------------------------------------------------------

function lintOneTool(
  tool: ToolSummary,
  nameCount: number,
  ajv: Ajv
): Finding[] {
  const out: Finding[] = [];

  // (1) tool.missing_description
  if (!tool.description || tool.description.trim().length === 0) {
    out.push({
      code: "tool.missing_description",
      severity: "error",
      message: `Tool '${tool.name}' has no description.`,
      location: { tool: tool.name },
      hint: "Add a one- or two-sentence description so language models can decide when to call it.",
    });
  } else if (tool.description.trim().length < THIN_DESCRIPTION_CHARS) {
    // (2) tool.thin_description — fires only when the description is
    //     present but too short to be useful to an agent.
    out.push({
      code: "tool.thin_description",
      severity: "warning",
      message: `Tool '${tool.name}' description is only ${tool.description.trim().length} characters.`,
      location: { tool: tool.name },
      hint: "Expand the description to at least 12 characters so it explains what the tool does and when to call it.",
    });
  }

  // (3) tool.duplicate_name
  if (nameCount > 1) {
    out.push({
      code: "tool.duplicate_name",
      severity: "error",
      message: `Tool name '${tool.name}' is registered ${nameCount} times.`,
      location: { tool: tool.name },
      hint: "Each tool name must be unique within a server. Rename or remove duplicates so agents can address a single implementation.",
    });
  }

  // (4) tool.unusual_name
  if (tool.name.length > 0 && !looksLikeStandardIdentifier(tool.name)) {
    out.push({
      code: "tool.unusual_name",
      severity: "warning",
      message: `Tool name '${tool.name}' is not snake_case or kebab-case.`,
      location: { tool: tool.name },
      hint: "Rename the tool using snake_case (e.g. 'get_user') or kebab-case (e.g. 'get-user') so it survives the typical agent naming filters.",
    });
  }

  // (12) tool.no_annotations — info-level nudge. Annotations are optional
  //      in MCP, but a tool that declares none gives an agent no signal
  //      about side effects (read-only vs destructive vs open-world).
  //      Checked here, before the schema rules' early return, so it fires
  //      even on a tool with no input schema.
  if (!tool.annotations || Object.keys(tool.annotations).length === 0) {
    out.push({
      code: "tool.no_annotations",
      severity: "info",
      message: `Tool '${tool.name}' declares no annotations.`,
      location: { tool: tool.name },
      hint: "Add MCP annotations (readOnlyHint, destructiveHint, idempotentHint, openWorldHint) so agents can reason about side effects before calling.",
    });
  }

  // (5) tool.no_input_schema
  const schema = tool.inputSchema;
  if (!schema || typeof schema !== "object" || Object.keys(schema).length === 0) {
    out.push({
      code: "tool.no_input_schema",
      severity: "warning",
      message: `Tool '${tool.name}' publishes no input schema.`,
      location: { tool: tool.name },
      hint: "Publish a JSON Schema (even an empty {type:'object', properties:{}}) so agents know the expected call shape.",
    });
    return out; // The remaining rules all need a usable schema.
  }

  // (7) schema.root_not_object — checked first because (6) below
  //     would otherwise mask it on a non-object root.
  if (schema.type !== undefined && schema.type !== "object") {
    out.push({
      code: "schema.root_not_object",
      severity: "warning",
      message: `Tool '${tool.name}' inputSchema root is type='${String(schema.type)}', expected 'object'.`,
      location: { tool: tool.name },
      hint: "MCP tool inputs are passed as an object. Set the root type to 'object' (or omit 'type' and add 'properties').",
    });
  }

  // (6) schema.invalid — try to compile and surface Ajv's verdict.
  try {
    ajv.compile(schema);
  } catch (err) {
    out.push({
      code: "schema.invalid",
      severity: "error",
      message: `Tool '${tool.name}' inputSchema failed to compile: ${(err as Error).message}`,
      location: { tool: tool.name },
      hint: "Fix the JSON Schema so Ajv accepts it. Common causes: bad $ref targets, unsupported keywords under strict mode, or malformed regex.",
    });
    // Continue with param-level rules — they don't depend on Ajv.
  }

  // (8) schema.no_required
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  if (Object.keys(props).length > 0 && required.length === 0) {
    out.push({
      code: "schema.no_required",
      severity: "info",
      message: `Tool '${tool.name}' declares ${Object.keys(props).length} parameter(s) but none are marked required.`,
      location: { tool: tool.name },
      hint: "Add a top-level 'required' array listing the mandatory parameters so agents know which ones to populate.",
    });
  }

  // (9) param.untyped + (10) param.missing_description
  for (const [paramName, paramSchemaRaw] of Object.entries(props)) {
    const paramSchema = (paramSchemaRaw ?? {}) as Record<string, unknown>;
    if (!isParamTyped(paramSchema)) {
      out.push({
        code: "param.untyped",
        severity: "warning",
        message: `Parameter '${paramName}' on tool '${tool.name}' has no type/enum/const/oneOf.`,
        location: { tool: tool.name, param: paramName },
        hint: "Add a 'type' (e.g. 'string'), an 'enum', or a 'oneOf' so agents know what values to pass.",
      });
    }
    if (
      typeof paramSchema.description !== "string" ||
      paramSchema.description.trim().length === 0
    ) {
      out.push({
        code: "param.missing_description",
        severity: "warning",
        message: `Parameter '${paramName}' on tool '${tool.name}' has no description.`,
        location: { tool: tool.name, param: paramName },
        hint: "Add a 'description' so language models fill the parameter with the right value.",
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const THIN_DESCRIPTION_CHARS = 12;

function looksLikeStandardIdentifier(name: string): boolean {
  // snake_case or kebab-case ASCII identifiers. Allow leading digit
  // (rare but legal in some tools) but require at least one letter.
  return /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(name);
}

function isParamTyped(schema: Record<string, unknown>): boolean {
  if (typeof schema.type === "string" && schema.type.length > 0) return true;
  if (Array.isArray(schema.type) && schema.type.length > 0) return true;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return true;
  if ("const" in schema) return true;
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) return true;
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) return true;
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) return true;
  return false;
}

function makeAjv(): Ajv {
  // The lint module compiles schemas, it does not validate data. We
  // therefore don't need ajv-formats here — saving the runtime import
  // and the typing headache of the default-export discrepancy.
  return new Ajv({
    strict: false,
    allErrors: true,
    // The linter is a pass over the schema, not a validation of user
    // input, so silence a few warnings we don't care about.
    logger: {
      log: () => {},
      warn: () => {},
      error: () => {},
    },
  });
}
