#!/usr/bin/env node
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
import {
  assertPublicUrl,
  checkStdioAllowed,
  guardedFetch,
  readPassEnv,
  readStdioPolicy,
  readUrlPolicy,
} from "./connect-policy.js";
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
// Output schemas — the shape of each tool's structuredContent. Declared so a
// host (and MCProbe auditing itself) can rely on the contract. Objects are
// non-strict: extra keys pass, so adding a field is not a breaking change.
// ---------------------------------------------------------------------------

const serverId = z.object({ name: z.string(), version: z.string() });
const countsShape = z.object({
  tools: z.number(),
  resources: z.number(),
  prompts: z.number(),
});
const findingsSummaryShape = z.object({
  total: z.number(),
  bySeverity: z.record(z.string(), z.number()),
  codes: z.array(z.string()),
});

const connectOutput = {
  connectionId: z.string(),
  name: z.string(),
  version: z.string(),
  capabilities: z.record(z.string(), z.unknown()),
  counts: countsShape,
  defaultConnectionId: z.string(),
};
const lintOutput = {
  connectionId: z.string(),
  server: serverId,
  findings: z.array(z.record(z.string(), z.unknown())),
  summary: findingsSummaryShape,
};
const fuzzOutput = {
  connectionId: z.string(),
  server: serverId,
  results: z.array(z.record(z.string(), z.unknown())),
  coverage: z.record(z.string(), z.unknown()),
  summary: z.record(z.string(), z.unknown()),
};
const reportOutput = {
  connectionId: z.string(),
  server: serverId,
  overall: z.number(),
  grade: z.enum(["A", "B", "C", "D", "F"]),
  dimensions: z.array(z.record(z.string(), z.unknown())),
  coverage: z.record(z.string(), z.unknown()).optional(),
  findings: z.array(z.record(z.string(), z.unknown())),
  fuzz: z.array(z.record(z.string(), z.unknown())),
  fuzzSummary: z.record(z.string(), z.unknown()),
  findingsSummary: findingsSummaryShape,
  markdown: z.string(),
};
const listOutput = {
  connectionId: z.string(),
  server: serverId,
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().nullable(),
      inputSchema: z.record(z.string(), z.unknown()),
    })
  ),
};
const disconnectOutput = {
  removed: z.number(),
  remaining: z.number(),
  defaultConnectionId: z.string().nullable(),
};

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
server.registerTool(
  "probe_connect",
  {
    description: "Open a connection to an MCP target server (stdio or HTTP) and return a connectionId plus the server's name, version, capabilities, and counts. stdio spawns a local process and is refused unless the operator allowed that command line via MCPROBE_ALLOW_STDIO; http URLs pointing at loopback/private/metadata addresses are refused unless MCPROBE_ALLOW_PRIVATE_URLS=1.",
    inputSchema: {
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
          "stdio: environment variables for the spawned process. The probe's own environment is NOT inherited; the target gets a minimal base (PATH, HOME, ...) plus these."
        ),
      url: z
        .url()
        .optional()
        .describe(
          "http: URL of the target MCP server. Required when transport='http'."
        ),
    },
    outputSchema: connectOutput,
    // Opens a connection to — and talks to — an external MCP server.
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async (args) => {
    const tool = "probe_connect";
    try {
      if (args.transport === "stdio") {
        if (!args.command) {
          return fail(tool, new Error("'command' is required when transport='stdio'"));
        }
        // Operator gate: an agent-supplied command line is code execution.
        const denied = checkStdioAllowed(
          readStdioPolicy(),
          args.command,
          args.args,
          args.env
        );
        if (denied) return fail(tool, new Error(denied));
        const conn = await connectStdio({
          command: args.command,
          args: args.args,
          env: args.env,
          passEnv: readPassEnv(),
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
      // SSRF guard: refuse loopback/private/metadata targets unless allowed,
      // and re-check every request (no redirects) through the guarded fetch.
      const urlPolicy = readUrlPolicy();
      await assertPublicUrl(args.url, urlPolicy);
      const conn = await connectHttp({ url: args.url, fetch: guardedFetch(urlPolicy) });
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
server.registerTool(
  "probe_lint",
  {
    description: "Run the lint rules over the target's tool schemas and return a list of findings with stable codes, severities, locations, and fix hints.",
    inputSchema: {
      connectionId: z
        .string()
        .optional()
        .describe(
          "Identifier returned by probe_connect. Defaults to the most recent connection if omitted."
        ),
    },
    outputSchema: lintOutput,
    // Pure read over cached tool summaries — no calls to the target.
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
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
// Substantive body: AC-5. For each eligible tool (destructive tools are
// skipped unless fuzzDestructive is set; the rest are capped at maxTools)
// it generates one valid and several malformed cases, invokes the target
// over the live protocol, and classifies each outcome as ok /
// toolError / protocolCrash. A malformed case that comes back without
// isError is recorded as silentlyAccepted — the "tool shrugged" case
// the fuzzer exists to surface. The response also carries a coverage
// summary of which tools were fuzzed vs skipped.
server.registerTool(
  "probe_fuzz",
  {
    description: "Generate one valid and several malformed inputs per target tool, call each, and record the outcome (ok, toolError, protocolCrash), whether malformed inputs were silently accepted, and call latency. Every fuzzed tool is really called. By default only tools annotated readOnlyHint:true or destructiveHint:false are fuzzed; set fuzzUnannotated to include tools without safety annotations, fuzzDestructive to include everything. Returns a coverage summary of which tools were fuzzed vs skipped.",
    inputSchema: {
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
      fuzzUnannotated: z
        .boolean()
        .optional()
        .describe(
          "Also fuzz tools that are not annotated readOnlyHint:true or destructiveHint:false. Default false: per the MCP spec such tools are presumed destructive, and fuzzing calls them for real."
        ),
    },
    outputSchema: fuzzOutput,
    // Invokes the target's tools with malformed inputs — has side effects.
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async (args) => {
    const tool = "probe_fuzz";
    try {
      const conn = getRegistry().get(args.connectionId);
      const { results, coverage } = await runFuzz(conn, conn.tools, {
        maxTools: args.maxTools,
        fuzzDestructive: args.fuzzDestructive,
        fuzzUnannotated: args.fuzzUnannotated,
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
server.registerTool(
  "probe_report",
  {
    description: "Run introspect + lint (and fuzz when requested) against the target, score the result on four dimensions, and return a Markdown report with the overall score, letter grade, per-dimension breakdown, findings, and fuzz table.",
    inputSchema: {
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
      fuzzUnannotated: z
        .boolean()
        .optional()
        .describe(
          "Also fuzz tools that are not annotated readOnlyHint:true or destructiveHint:false. Default false: per the MCP spec such tools are presumed destructive, and fuzzing calls them for real."
        ),
    },
    outputSchema: reportOutput,
    // Lints always; also fuzzes the target's tools when fuzz=true.
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
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
            fuzzUnannotated: args.fuzzUnannotated,
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
        { fuzzMeasured: fuzzEnabled, coverage: fuzzRun?.coverage, toolCount: conn.tools.length }
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
server.registerTool(
  "probe_list",
  {
    description: "Enumerate the target's tools (name, description, input schema) using the default or a specific connection.",
    inputSchema: {
      connectionId: z
        .string()
        .optional()
        .describe("Identifier returned by probe_connect. Defaults to the most recent connection."),
    },
    outputSchema: listOutput,
    // Enumerates cached tool summaries — no calls to the target.
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
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
server.registerTool(
  "probe_disconnect",
  {
    description: "Close a single connection (by id) or all connections if id is omitted.",
    inputSchema: {
      id: z
        .string()
        .optional()
        .describe("Connection id returned by probe_connect. Omit to close every connection."),
    },
    outputSchema: disconnectOutput,
    // Closes a local connection; closing an already-closed id is a no-op.
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (args) => {
    const tool = "probe_disconnect";
    try {
      const summary = await getRegistry().disconnect(args.id);
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

// Dispatch: a recognized first argument runs the CLI (audit / push / help);
// no arguments (or `serve`) boots the MCP server — the original behavior, so
// existing `mcprobe` MCP-client configs keep working unchanged.
const firstArg = process.argv[2];
const runAsCli = Boolean(firstArg) && firstArg !== "serve";

if (runAsCli) {
  import("./cli.js")
    .then(({ runCli }) => runCli(process.argv.slice(2)))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("[mcprobe] fatal:", err);
      process.exit(1);
    });
} else {
  main().catch((err) => {
    console.error("[mcprobe] fatal:", err);
    process.exit(1);
  });
}
