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
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolSummary } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ConnectStdioOptions {
  command: string;
  args?: string[];
  /** Environment variables set on the spawned process, on top of a minimal
   *  safe base (see `buildStdioEnv`). The parent environment is NOT inherited. */
  env?: Record<string, string>;
  /** Names of parent-process environment variables to forward to the target
   *  (e.g. `["BYLINE_API_KEY"]`). Lets a caller hand a credential to the
   *  target without inheriting everything else in the parent env. */
  passEnv?: string[];
  cwd?: string;
}

export interface ConnectHttpOptions {
  url: string;
  /** Force a particular transport when both are available. Defaults to
   *  "streamable" — the modern replacement — and falls back to SSE. */
  prefer?: "streamable" | "sse";
  /** Custom fetch used for every network request the HTTP transport makes.
   *  Lets an embedder wrap requests with their own policy (e.g. an SSRF guard
   *  that re-checks the host and refuses redirects). Defaults to global fetch. */
  fetch?: FetchLike;
  /** Extra request headers — how you audit a server that requires credentials
   *  (`{ Authorization: "Bearer sk-..." }`, `{ "X-API-Key": "..." }`).
   *
   *  Sent on every request to the target, so only point this at a server you
   *  trust: whoever controls the URL receives the credential. Values are
   *  validated by `sanitizeHeaders` and never logged. */
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Credential hygiene
// ---------------------------------------------------------------------------

/** Headers the transports own. Overriding any of these breaks the protocol
 *  (or lets a caller retarget the request), so they are refused outright
 *  rather than silently dropped. */
const RESERVED_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
]);

/** Query parameters whose values are treated as secrets when a URL is logged. */
const SECRET_PARAMS =
  /^(api[-_]?key|access[-_]?token|auth|authorization|key|password|secret|token)$/i;

/**
 * Validate caller-supplied request headers.
 *
 * Throws rather than dropping a bad header: silently ignoring a malformed
 * `Authorization` would surface as a confusing 401 from the target instead of
 * the real cause. Rejects CR/LF and control characters (header injection) and
 * transport-owned names.
 */
export function sanitizeHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim();
    const value = typeof rawValue === "string" ? rawValue.trim() : "";
    if (!name) throw new Error("header name cannot be empty");
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
      throw new Error(`invalid header name: ${name}`);
    }
    // Control characters are the header-injection vector (CR/LF splits
    // one header into two). Escapes, not literals, so the source stays
    // free of raw control bytes.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001F\u007F]/.test(value)) {
      throw new Error(`header ${name} contains control characters`);
    }
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      throw new Error(`header ${name} is managed by the transport and cannot be set`);
    }
    if (!value) continue; // an empty value is a no-op, not an error
    out[name] = value;
  }
  return out;
}

/**
 * Mask credentials embedded in a URL so it is safe to log or echo in an error.
 * Covers both `https://user:pass@host` and `?api_key=...` styles.
 *
 * Implemented with string surgery rather than the URL API on purpose: this
 * package compiles with `lib: ES2022` and no `@types/node`, so `URL`'s
 * `username`/`searchParams` members aren't in scope here.
 */
export function redactUrl(raw: string): string {
  if (typeof raw !== "string" || !raw) return "<empty url>";

  // scheme://user:pass@host -> scheme://***@host
  let out = raw.replace(/^([a-z][a-z0-9+.\-]*:\/\/)[^/?#@]*@/i, "$1***@");

  // ?token=secret&x=1 -> ?token=***&x=1  (also masks the fragment's query)
  const q = out.indexOf("?");
  if (q !== -1) {
    const hash = out.indexOf("#", q);
    const end = hash === -1 ? out.length : hash;
    const masked = out
      .slice(q + 1, end)
      .split("&")
      .map((pair) => {
        const eq = pair.indexOf("=");
        if (eq <= 0) return pair;
        const key = pair.slice(0, eq);
        return SECRET_PARAMS.test(decodeURIComponent(key)) ? `${key}=***` : pair;
      })
      .join("&");
    out = out.slice(0, q + 1) + masked + out.slice(end);
  }
  return out;
}

export interface CallToolResult {
  ok: boolean;
  isError: boolean;
  content: unknown[];
  /** Structured output the tool returned (MCP structured output), if any. */
  structuredContent?: unknown;
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
  async disconnect(id?: string): Promise<{ removed: number; remaining: number }> {
    if (id === undefined) {
      const all = Array.from(this.connections.values());
      // Drop them from the registry first so a concurrent get() can't hand
      // out a connection that is mid-close.
      this.connections.clear();
      this.defaultId = null;
      await Promise.all(all.map((c) => this.closeQuietly(c)));
      return { removed: all.length, remaining: 0 };
    }
    const target = this.connections.get(id);
    if (!target) {
      return { removed: 0, remaining: this.connections.size };
    }
    this.connections.delete(id);
    if (this.defaultId === id) {
      // Fall back to any other live connection, or null when none.
      const next = this.connections.keys().next();
      this.defaultId = next.done ? null : next.value;
    }
    await this.closeQuietly(target);
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

  /** Close a connection, awaiting the transport shutdown (for stdio, the
   *  child process exit) so callers don't leak processes or race a reconnect.
   *  Both a synchronous throw and a rejected promise are logged, not raised. */
  private async closeQuietly(c: Connection): Promise<void> {
    try {
      await c.client.close();
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
    outputSchema?: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  };
  return {
    name: String(t.name ?? ""),
    description: typeof t.description === "string" ? t.description : undefined,
    inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    outputSchema:
      t.outputSchema && typeof t.outputSchema === "object"
        ? t.outputSchema
        : undefined,
    annotations:
      t.annotations && typeof t.annotations === "object"
        ? t.annotations
        : undefined,
  };
}

/**
 * Build the environment for a spawned stdio target.
 *
 * The target is untrusted code, so it must not see the probe's own secrets
 * (`MCPROBE_TOKEN`, `MCPROBE_TARGET_TOKEN`, CI tokens, cloud credentials...).
 * Start from the MCP SDK's minimal default environment (`PATH`, `HOME`,
 * `USER`, `SHELL`, `TERM`, ... — enough to launch `node`/`npx`), then add only
 * the parent variables the caller names in `passEnv`, then the explicit `env`.
 *
 * Exported for unit testing.
 */
export function buildStdioEnv(
  env?: Record<string, string>,
  passEnv?: string[],
  parent: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const out: Record<string, string> = { ...getDefaultEnvironment() };
  for (const name of passEnv ?? []) {
    const value = parent[name];
    if (typeof value === "string") out[name] = value;
  }
  if (env) {
    for (const [k, v] of Object.entries(env)) out[k] = v;
  }
  return out;
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
    env: buildStdioEnv(opts.env, opts.passEnv),
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

/** HTTP statuses that mean "this endpoint doesn't speak streamable HTTP" —
 *  the MCP spec's cue to retry with the legacy HTTP+SSE transport. An auth
 *  failure (401/403) or a 5xx is a real error and is not retried. */
const LEGACY_FALLBACK_STATUSES = new Set([400, 404, 405]);

/** True when a streamable-HTTP connect failure should be retried over the
 *  legacy SSE transport. Exported for tests. */
export function shouldFallBackToSse(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "number" && LEGACY_FALLBACK_STATUSES.has(code);
}

export async function connectHttp(opts: ConnectHttpOptions): Promise<Connection> {
  if (!opts.url || typeof opts.url !== "string") {
    throw new Error("connectHttp: 'url' is required");
  }
  const transportOpts = httpTransportOptions(opts);
  const url = new URL(opts.url);

  if (opts.prefer === "sse") {
    const client = makeClient();
    await client.connect(new SSEClientTransport(url, transportOpts));
    console.error(`[mcprobe] connected (http+sse): ${redactUrl(opts.url)}`);
    return finalizeConnection(client, "http");
  }

  // Prefer streamable HTTP. Per the spec's backwards-compatibility rules, if
  // the initialize POST is rejected with 400/404/405 the server may be a
  // legacy HTTP+SSE server, so retry with that transport. Constructing a
  // transport never fails — the error only surfaces from connect().
  const client = makeClient();
  try {
    await client.connect(new StreamableHTTPClientTransport(url, transportOpts));
    console.error(`[mcprobe] connected (http): ${redactUrl(opts.url)}`);
    return finalizeConnection(client, "http");
  } catch (err) {
    if (!shouldFallBackToSse(err)) throw err;
    console.error(
      `[mcprobe] streamable-http rejected by ${redactUrl(opts.url)} (${(err as Error).message}); retrying with legacy SSE`
    );
    const sseClient = makeClient();
    try {
      await sseClient.connect(new SSEClientTransport(url, transportOpts));
    } catch (sseErr) {
      throw new Error(
        `streamable HTTP failed (${(err as Error).message}) and legacy SSE failed (${(sseErr as Error).message})`
      );
    }
    console.error(`[mcprobe] connected (http+sse): ${redactUrl(opts.url)}`);
    return finalizeConnection(sseClient, "http");
  }
}

/** Shared options for both HTTP transports. Passes the embedder's custom
 *  fetch and any auth headers through. Both transports merge
 *  `requestInit.headers` into every request they make — for SSE that includes
 *  the event-stream GET, not just the POSTs — so one option covers the whole
 *  session. */
function httpTransportOptions(opts: ConnectHttpOptions) {
  const headers = opts.headers ? sanitizeHeaders(opts.headers) : undefined;
  return opts.fetch || headers
    ? {
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(headers ? { requestInit: { headers } } : {}),
      }
    : undefined;
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
      structuredContent: (result as { structuredContent?: unknown }).structuredContent,
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

export async function resetRegistryForTest(): Promise<void> {
  activeRegistry = defaultRegistry;
  await defaultRegistry.disconnect();
}
