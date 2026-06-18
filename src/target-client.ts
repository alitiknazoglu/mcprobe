// Outbound MCP client. MCProbe plays two roles at once — it is a stdio
// MCP server to its host, and an MCP *client* to whatever it is auditing.
// This module owns the second role: spawning or dialing target servers,
// running the initialize handshake, caching their advertised shape
// (tools/resources/prompts), and exposing a tiny in-memory registry so
// the rest of the probe can refer to "the default connection" without
// threading a connectionId through every call.
//
// All log lines go to stderr (console.error). Stdout is the host-facing
// JSON-RPC transport and must never be interleaved with application logs.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolSummary } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ConnectStdioOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface ConnectHttpOptions {
  url: string;
  /** Force a particular transport when both are available. Defaults to
   *  "streamable" — the modern replacement — and falls back to SSE. */
  prefer?: "streamable" | "sse";
}

export interface CallToolResult {
  ok: boolean;
  isError: boolean;
  content: unknown[];
  error?: string;
  latencyMs: number;
}

export interface Connection {
  id: string;
  transportKind: "stdio" | "http";
  client: Client;
  /** Server-reported identity from the initialize handshake. */
  serverInfo: { name: string; version: string; instructions?: string };
  /** Raw capabilities object reported by the target (may be empty). */
  capabilities: Record<string, unknown>;
  /** Counts of advertised resources. */
  counts: { tools: number; resources: number; prompts: number };
  /** Cached tool summaries so the lint rules can iterate without an
   *  extra round-trip. Populated at connect time. */
  tools: ToolSummary[];
}

export interface ConnectOutcome {
  connectionId: string;
  name: string;
  version: string;
  capabilities: Record<string, unknown>;
  counts: { tools: number; resources: number; prompts: number };
  /** Default connection becomes the most recently added one. */
  defaultConnectionId: string;
}

// ---------------------------------------------------------------------------
// ConnectionRegistry — in-memory, last-write-wins default
// ---------------------------------------------------------------------------

/** Internal counter so connectionIds are stable and monotonic within a
 *  single process lifetime. */
let connCounter = 0;

function newConnectionId(): string {
  connCounter += 1;
  // A short random tail avoids collisions if two probes run in the
  // same wall clock millisecond; the prefix gives the operator a
  // human-readable scan.
  const tail = Math.random().toString(36).slice(2, 8);
  return `conn-${connCounter}-${tail}`;
}

export class ConnectionRegistry {
  private readonly connections = new Map<string, Connection>();
  private defaultId: string | null = null;

  /** Insert a freshly-built connection. The new connection becomes
   *  the default — matches the spec's "subsequent tool calls default
   *  to the most recent connection" rule. */
  add(conn: Connection): void {
    this.connections.set(conn.id, conn);
    this.defaultId = conn.id;
  }

  /** Resolve an id (or the default) to a live connection, or throw
   *  a clean Error that the caller can surface via isError. */
  get(id?: string): Connection {
    if (id) {
      const c = this.connections.get(id);
      if (!c) {
        throw new Error(`connection '${id}' not found`);
      }
      return c;
    }
    if (this.defaultId === null) {
      throw new Error(
        "no default connection — call probe_connect first to open one"
      );
    }
    const c = this.connections.get(this.defaultId);
    if (!c) {
      // Should never happen since we delete in lockstep with the
      // defaultId update, but defend against it.
      this.defaultId = null;
      throw new Error("default connection no longer exists");
    }
    return c;
  }

  /** Close one or every connection. Returns a tiny summary so the
   *  handler can echo something useful. */
  disconnect(id?: string): { removed: number; remaining: number } {
    if (id === undefined) {
      const removed = this.connections.size;
      for (const c of this.connections.values()) {
        this.closeQuietly(c);
      }
      this.connections.clear();
      this.defaultId = null;
      return { removed, remaining: 0 };
    }
    const target = this.connections.get(id);
    if (!target) {
      return { removed: 0, remaining: this.connections.size };
    }
    this.closeQuietly(target);
    this.connections.delete(id);
    if (this.defaultId === id) {
      // Fall back to any other live connection, or null when none.
      const next = this.connections.keys().next();
      this.defaultId = next.done ? null : next.value;
    }
    return { removed: 1, remaining: this.connections.size };
  }

  /** Snapshot of live connection ids — for diagnostics and the
   *  probe_disconnect handler. */
  list(): string[] {
    return Array.from(this.connections.keys());
  }

  /** Exposed for tests and the AC-3 smoke script. */
  get defaultConnectionId(): string | null {
    return this.defaultId;
  }

  private closeQuietly(c: Connection): void {
    try {
      c.client.close();
    } catch (err) {
      console.error(
        `[mcprobe] warning: error closing connection ${c.id}:`,
        (err as Error).message
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Connect helpers
// ---------------------------------------------------------------------------

/** Per-request timeout for introspection list calls. A target that never
 *  answers a `list*` request would otherwise stall the connect for the SDK's
 *  default request timeout (60s); a short bound makes a silent server fail
 *  fast so the audit can continue. */
const LIST_TIMEOUT_MS = 15_000;

/**
 * Best-effort enumeration of a target's tools/resources/prompts.
 *
 * Introspection must never crash the probe. A target may not implement an
 * optional method (it returns -32601 "method not found"), or it may simply
 * never respond — in which case the SDK times out (-32001). Some servers do
 * the latter even for methods they don't support. Either way we degrade to an
 * empty list and let the audit continue, rather than letting the error escape
 * and kill the connection. A bounded per-request timeout keeps a silent
 * server from stalling the whole connect.
 *
 * Exported for unit testing.
 */
export async function safeList(
  client: Client,
  method: "tools" | "resources" | "prompts"
): Promise<unknown[]> {
  const options = { timeout: LIST_TIMEOUT_MS };
  try {
    if (method === "tools") {
      const r = await client.listTools(undefined, options);
      return r.tools ?? [];
    }
    if (method === "resources") {
      const r = await client.listResources(undefined, options);
      return r.resources ?? [];
    }
    const r = await client.listPrompts(undefined, options);
    return r.prompts ?? [];
  } catch (err) {
    // Any failure — "method not found", a request timeout, or a transport
    // error — means we couldn't enumerate this feature. Count 0 and move on.
    console.error(
      `[mcprobe] ${method}/list unavailable (${(err as Error).message ?? String(err)}); counting 0`
    );
    return [];
  }
}

function toToolSummary(raw: unknown): ToolSummary {
  const t = raw as {
    name?: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  };
  return {
    name: String(t.name ?? ""),
    description: typeof t.description === "string" ? t.description : undefined,
    inputSchema: t.inputSchema ?? { type: "object", properties: {} },
  };
}

/** Inherit the parent process env, then layer caller-supplied keys on
 *  top so callers can override `PATH` etc. explicitly. */
function mergedStdioEnv(env?: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >;
  if (env) {
    for (const [k, v] of Object.entries(env)) {
      merged[k] = v;
    }
  }
  return merged;
}

async function finalizeConnection(
  client: Client,
  transportKind: "stdio" | "http"
): Promise<Connection> {
  const serverInfo = client.getServerVersion() ?? {
    name: "unknown",
    version: "unknown",
  };
  const instructions = (() => {
    try {
      return client.getInstructions?.() ?? undefined;
    } catch {
      return undefined;
    }
  })();
  const capabilities = (client.getServerCapabilities() ?? {}) as Record<
    string,
    unknown
  >;

  const tools = ((await safeList(client, "tools")) as unknown[]).map(
    toToolSummary
  );
  // Only query the optional features the server actually advertised. A server
  // that doesn't support resources/prompts may stay silent rather than return
  // "method not found", which would otherwise stall the connect until the
  // request times out. Gating on the advertised capability avoids the hang.
  const resources = capabilities.resources
    ? await safeList(client, "resources")
    : [];
  const prompts = capabilities.prompts
    ? await safeList(client, "prompts")
    : [];

  return {
    id: newConnectionId(),
    transportKind,
    client,
    serverInfo: {
      name: serverInfo.name,
      version: serverInfo.version,
      instructions,
    },
    capabilities,
    counts: {
      tools: tools.length,
      resources: resources.length,
      prompts: prompts.length,
    },
    tools,
  };
}

function makeClient(): Client {
  return new Client(
    { name: "mcprobe", version: "0.1.0" },
    { capabilities: {} }
  );
}

export async function connectStdio(
  opts: ConnectStdioOptions
): Promise<Connection> {
  if (!opts.command || typeof opts.command !== "string") {
    throw new Error("connectStdio: 'command' is required");
  }
  const transport = new StdioClientTransport({
    command: opts.command,
    args: opts.args ?? [],
    env: mergedStdioEnv(opts.env),
    cwd: opts.cwd,
    // Inherit stderr by default so the operator sees target log
    // output intermixed with the probe's own stderr stream.
    stderr: "inherit",
  });
  const client = makeClient();
  await client.connect(transport);
  console.error(
    `[mcprobe] connected (stdio): ${opts.command} ${(opts.args ?? []).join(" ")}`.trim()
  );
  return finalizeConnection(client, "stdio");
}

export async function connectHttp(opts: ConnectHttpOptions): Promise<Connection> {
  if (!opts.url || typeof opts.url !== "string") {
    throw new Error("connectHttp: 'url' is required");
  }
  const transport: Transport = createHttpTransport(opts);
  const client = makeClient();
  await client.connect(transport);
  console.error(`[mcprobe] connected (http): ${opts.url}`);
  return finalizeConnection(client, "http");
}

function createHttpTransport(opts: ConnectHttpOptions): Transport {
  // Prefer the modern streamable HTTP transport. The spec tells us to
  // fall back to SSE if the resolved SDK version doesn't expose it.
  if (opts.prefer !== "sse") {
    try {
      return new StreamableHTTPClientTransport(new URL(opts.url));
    } catch (err) {
      console.error(
        `[mcprobe] streamable-http transport failed to construct for ${opts.url}, falling back to SSE:`,
        (err as Error).message
      );
    }
  }
  return new SSEClientTransport(new URL(opts.url));
}

// ---------------------------------------------------------------------------
// Operation helpers
// ---------------------------------------------------------------------------

export async function callTool(
  connection: Connection,
  name: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const start = process.hrtime.bigint();
  try {
    const result = await connection.client.callTool({ name, arguments: args });
    const latencyMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
    return {
      ok: true,
      isError: Boolean(result.isError),
      content: Array.isArray(result.content) ? result.content : [],
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
    return {
      ok: false,
      isError: true,
      content: [],
      error: (err as Error).message ?? String(err),
      latencyMs,
    };
  }
}

export async function listToolSummaries(
  connection: Connection
): Promise<ToolSummary[]> {
  return connection.tools;
}

// ---------------------------------------------------------------------------
// Module-level singleton registry shared by all handler invocations in
// a single probe process. Tests can pass their own registry via
// setRegistryForTest().
// ---------------------------------------------------------------------------

const defaultRegistry = new ConnectionRegistry();
let activeRegistry: ConnectionRegistry = defaultRegistry;

export function getRegistry(): ConnectionRegistry {
  return activeRegistry;
}

export function setRegistryForTest(reg: ConnectionRegistry): void {
  activeRegistry = reg;
}

export function resetRegistryForTest(): void {
  activeRegistry = defaultRegistry;
  defaultRegistry.disconnect();
}
