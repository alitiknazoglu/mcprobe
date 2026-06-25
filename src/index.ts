// MCProbe entry point.
//
// Owns the McpServer, registers the six probe_* tools (four core + two
// optional helpers) defined in the spec, and routes them to the
// underlying pure-logic modules. Handler bodies never throw out — they
// return MCP error results with isError: true so the host gets a clean
// error message instead of a protocol crash.
//
// Logging convention: every operator-visible line goes to console.error.
// Stdout is owned by the JSON-RPC transport and must never be interleaved
// with application output.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  connectStdio,
  connectHttp,
  getRegistry,
  type ConnectOutcome,
} from "./target-client.js";
import { lintTools } from "./schema-lint.js";
import { runFuzz, summarizeFuzz } from "./fuzz.js";
import { buildReport } from "./conformance.js";
import { renderReport } from "./report.js";
import type { Finding } from "./types.js";

// ---------------------------------------------------------------------------
// Handler-result helpers
// ---------------------------------------------------------------------------

/** Serialize an arbitrary JSON-safe value into a text result that also
 *  surfaces the payload via structuredContent. Untyped so the literal
 *  shape stays structurally compatible with the SDK's CallToolResult
 *  (which expects an index signature). */
function ok<T>(payload: T): CallToolResult {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload as unknown as Record<string, unknown>,
  };
}

/** Build a clean MCP error result that the SDK serializes with isError: true. */
function fail(tool: string, err: unknown): CallToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: `[${tool}] ${msg}`,
      },
    ],
  };
}

/** Tiny severity histogram — convenient for the smoke script and for
 *  the report renderer (AC-6) so it doesn't have to recompute. */
function summarize(findings: Finding[]): {
  total: number;
  bySeverity: Record<string, number>;
  codes: string[];
} {
  const bySeverity: Record<string, number> = {
    error: 0,
    warning: 0,
    info: 0,
  };
  const codeSet = new Set<string>();
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    codeSet.add(f.code);
  }
  return {
    total: findings.length,
    bySeverity,
    codes: Array.from(codeSet).sort(),
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer(
  {
    name: "mcprobe",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ---------------------------------------------------------------------------
// Tool registrations
// ---------------------------------------------------------------------------

// probe_connect — open a connection to a target. Substantive body: AC-3.
server.tool(
  "probe_connect",
  "Open a connection to an MCP target server (stdio or HTTP) and return a connectionId plus the server's name, version, capabilities, and counts.",
  {
    transport: z.enum(["stdio", "http"]).describe(
      "Transport to use. 'stdio' spawns a child process; 'http' speaks the streamable HTTP transport."
    ),
    command: z
      .string()
      .optional()
      .describe(
        "stdio: executable to spawn (e.g. 'node'). Required when transport='stdio'."
      ),
    args: z
      .array(z.string())
      .optional()
      .describe("stdio: arguments passed to the spawned process."),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "stdio: extra environment variables layered on top of the parent process env."
      ),
    url: z
      .string()
      .url()
      .optional()
      .describe(
        "http: URL of the target MCP server. Required when transport='http'."
      ),
  },
  // Opens a connection to — and talks to — an external MCP server.
  { readOnlyHint: false, openWorldHint: true },
  async (args) => {
    const tool = "probe_connect";
    try {
      if (args.transport === "stdio") {
        if (!args.command) {
          return fail(tool, new Error("'command' is required when transport='stdio'"));
        }
        const conn = await connectStdio({
          command: args.command,
          args: args.args,
          env: args.env,
        });
        getRegistry().add(conn);
        const outcome: ConnectOutcome = {
          connectionId: conn.id,
          name: conn.serverInfo.name,
          version: conn.serverInfo.version,
          capabilities: conn.capabilities,
          counts: conn.counts,
          defaultConnectionId: getRegistry().defaultConnectionId ?? conn.id,
        };
        return ok(outcome);
      }
      // http
      if (!args.url) {
        return fail(tool, new Error("'url' is required when transport='http'"));
      }
      const conn = await connectHttp({ url: args.url });
      getRegistry().add(conn);
      const outcome: ConnectOutcome = {
        connectionId: conn.id,
        name: conn.serverInfo.name,
        version: conn.serverInfo.version,
        capabilities: conn.capabilities,
        counts: conn.counts,
        defaultConnectionId: getRegistry().defaultConnectionId ?? conn.id,
      };
      return ok(outcome);
    } catch (err) {
      return fail(tool, err);
    }
  }
);

// probe_lint — static schema audit. Substantive body: AC-4.
server.tool(
  "probe_lint",
  "Run the lint rules over the target's tool schemas and return a list of findings with stable codes, severities, locations, and fix hints.",
  {
    connectionId: z
      .string()
      .optional()
      .describe(
        "Identifier returned by probe_connect. Defaults to the most recent connection if omitted."
      ),
  },
  // Pure read over cached tool summaries — no calls to the target.
  { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async (args) => {
    const tool = "probe_lint";
    try {
      const conn = getRegistry().get(args.connectionId);
      const toolsCapability = Boolean(
        (conn.capabilities as { tools?: unknown }).tools
      );
      const findings = lintTools(conn.tools, toolsCapability);
      return ok({
        connectionId: conn.id,
        server: { name: conn.serverInfo.name, version: conn.serverInfo.version },
        findings,
        summary: summarize(findings),
      });
    } catch (err) {
      return fail(tool, err);
    }
  }
);

// probe_fuzz — behavioral audit, actually calls the target's tools.
// Substantive body: AC-5. For each tool (capped at maxTools) it
// generates one valid and several malformed cases, invokes the target
// over the live protocol, and classifies each outcome as ok /
// toolError / protocolCrash. A malformed case that comes back without
// isError is recorded as silentlyAccepted — the "tool shrugged" case
// the fuzzer exists to surface.
server.tool(
  "probe_fuzz",
  "Generate one valid and several malformed inputs per target tool, call each, and record the outcome (ok, toolError, protocolCrash), whether malformed inputs were silently accepted, and call latency. Tools annotated destructiveHint:true are skipped by default (set fuzzDestructive to include them). Returns a coverage summary of which tools were fuzzed vs skipped.",
  {
    connectionId: z
      .string()
      .optional()
      .describe("Identifier returned by probe_connect. Defaults to the most recent connection."),
    maxTools: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Cap on the number of tools to fuzz. Defaults to 10."),
    fuzzDestructive: z
      .boolean()
      .optional()
      .describe(
        "Also fuzz tools annotated destructiveHint:true. Default false (the dry-run safety guard) so fuzzing an untrusted target can't trigger a destructive action."
      ),
  },
  // Invokes the target's tools with malformed inputs — has side effects.
  { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  async (args) => {
    const tool = "probe_fuzz";
    try {
      const conn = getRegistry().get(args.connectionId);
      const { results, coverage } = await runFuzz(conn, conn.tools, {
        maxTools: args.maxTools,
        fuzzDestructive: args.fuzzDestructive,
      });
      return ok({
        connectionId: conn.id,
        server: { name: conn.serverInfo.name, version: conn.serverInfo.version },
        results,
        coverage,
        summary: summarizeFuzz(results),
      });
    } catch (err) {
      return fail(tool, err);
    }
  }
);

// probe_report — full audit + score. Substantive body: AC-6.
// Orchestrates lint (always) and fuzz (when requested) against the
// target, scores on the four documented dimensions, and renders the
// result as Markdown. The Markdown is the canonical payload — the
// structured ConformanceReport is also surfaced via
// structuredContent for any host that wants to parse it.
server.tool(
  "probe_report",
  "Run introspect + lint (and fuzz when requested) against the target, score the result on four dimensions, and return a Markdown report with the overall score, letter grade, per-dimension breakdown, findings, and fuzz table.",
  {
    connectionId: z
      .string()
      .optional()
      .describe("Identifier returned by probe_connect. Defaults to the most recent connection."),
    fuzz: z
      .boolean()
      .optional()
      .describe(
        "When true, run the behavioral fuzzer before scoring. Default false; only static dimensions are measured when omitted."
      ),
    maxTools: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Forwarded to probe_fuzz when fuzz=true. Defaults to 10."),
    fuzzDestructive: z
      .boolean()
      .optional()
      .describe(
        "Forwarded to probe_fuzz when fuzz=true. Also fuzz tools annotated destructiveHint:true (default false — the dry-run safety guard)."
      ),
  },
  // Lints always; also fuzzes the target's tools when fuzz=true.
  { readOnlyHint: false, openWorldHint: true },
  async (args) => {
    const tool = "probe_report";
    try {
      const conn = getRegistry().get(args.connectionId);
      const toolsCapability = Boolean(
        (conn.capabilities as { tools?: unknown }).tools
      );
      const findings = lintTools(conn.tools, toolsCapability);

      const fuzzEnabled = args.fuzz === true;
      const fuzzRun = fuzzEnabled
        ? await runFuzz(conn, conn.tools, {
            maxTools: args.maxTools,
            fuzzDestructive: args.fuzzDestructive,
          })
        : undefined;
      const fuzzResults = fuzzRun?.results ?? [];

      const report = buildReport(
        {
          name: conn.serverInfo.name,
          version: conn.serverInfo.version,
          instructions: conn.serverInfo.instructions,
        },
        conn.capabilities,
        findings,
        fuzzResults,
        { fuzzMeasured: fuzzEnabled, coverage: fuzzRun?.coverage }
      );

      const markdown = renderReport(report);
      return ok({
        connectionId: conn.id,
        server: conn.serverInfo,
        overall: report.overall,
        grade: report.grade,
        dimensions: report.dimensions,
        coverage: fuzzRun?.coverage,
        findings,
        fuzz: fuzzResults,
        fuzzSummary: summarizeFuzz(fuzzResults),
        findingsSummary: summarize(findings),
        markdown,
      });
    } catch (err) {
      return fail(tool, err);
    }
  }
);

// probe_list (optional helper) — enumerate the target's tools.
server.tool(
  "probe_list",
  "Enumerate the target's tools (name, description, input schema) using the default or a specific connection.",
  {
    connectionId: z
      .string()
      .optional()
      .describe("Identifier returned by probe_connect. Defaults to the most recent connection."),
  },
  // Enumerates cached tool summaries — no calls to the target.
  { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async (args) => {
    const tool = "probe_list";
    try {
      const conn = getRegistry().get(args.connectionId);
      const payload = {
        connectionId: conn.id,
        server: conn.serverInfo,
        tools: conn.tools.map((t) => ({
          name: t.name,
          description: t.description ?? null,
          inputSchema: t.inputSchema,
        })),
      };
      return ok(payload);
    } catch (err) {
      return fail(tool, err);
    }
  }
);

// probe_disconnect (optional helper) — close one or all connections.
server.tool(
  "probe_disconnect",
  "Close a single connection (by id) or all connections if id is omitted.",
  {
    id: z
      .string()
      .optional()
      .describe("Connection id returned by probe_connect. Omit to close every connection."),
  },
  // Closes a local connection; closing an already-closed id is a no-op.
  { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  async (args) => {
    const tool = "probe_disconnect";
    try {
      const summary = getRegistry().disconnect(args.id);
      return ok({
        removed: summary.removed,
        remaining: summary.remaining,
        defaultConnectionId: getRegistry().defaultConnectionId,
      });
    } catch (err) {
      return fail(tool, err);
    }
  }
);

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcprobe] stdio server ready");
}

main().catch((err) => {
  console.error("[mcprobe] fatal:", err);
  process.exit(1);
});
