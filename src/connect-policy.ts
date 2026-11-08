// Operator policy for the `probe_connect` MCP tool.
//
// `probe_connect` takes its command / env / url from whoever drives the probe
// — usually an LLM agent, which may be acting on a prompt injection. Without
// a gate, "connect to this stdio server" is arbitrary code execution and
// "connect to this url" is an SSRF primitive. This module holds the policy the
// operator (whoever writes the MCP host config) sets through environment
// variables:
//
//   MCPROBE_ALLOW_STDIO         unset  -> stdio spawning via probe_connect is refused
//                               "*"    -> any command (you accept the risk)
//                               "a; b" -> only these exact command lines
//   MCPROBE_PASS_ENV            comma-separated variable names forwarded from the
//                               probe's own env to spawned targets
//   MCPROBE_ALLOW_PRIVATE_URLS  "1" -> allow loopback / private-network URLs
//
// The CLI and library are not gated: there the caller is the operator.
//
// Pure apart from DNS resolution in assertPublicUrl, so it is unit-testable
// without booting the server (index.ts starts the server on import).

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

// ---------------------------------------------------------------------------
// stdio spawn gate
// ---------------------------------------------------------------------------

export type StdioPolicy =
  | { mode: "off" }
  | { mode: "any" }
  | { mode: "list"; allowed: string[] };

/** Variables that make an interpreter or the dynamic linker load extra code.
 *  An agent that can set these can turn an allowlisted command line into
 *  arbitrary code execution, so they are refused unless the policy is "*". */
const CODE_LOADING_ENV =
  /^(PATH|NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_.*|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|BASH_ENV|ENV|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|GIT_.*|npm_config_.*|NPM_CONFIG_.*)$/i;

/** Collapse runs of whitespace so an allowlist entry and a command line
 *  compare equal regardless of incidental spacing. */
function normalizeCommandLine(s: string): string {
  return s.trim().split(/\s+/).filter(Boolean).join(" ");
}

export function readStdioPolicy(env: NodeJS.ProcessEnv = process.env): StdioPolicy {
  const raw = (env.MCPROBE_ALLOW_STDIO ?? "").trim();
  if (!raw) return { mode: "off" };
  if (raw === "*") return { mode: "any" };
  const allowed = raw
    .split(/[;\n]/)
    .map(normalizeCommandLine)
    .filter(Boolean);
  return allowed.length > 0 ? { mode: "list", allowed } : { mode: "off" };
}

/** Parent-env names the operator forwards to every spawned target. */
export function readPassEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.MCPROBE_PASS_ENV ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Decide whether `probe_connect` may spawn this command. Returns null when
 * allowed, or a human-readable refusal (safe to show the caller: it names the
 * policy, not any secret).
 */
export function checkStdioAllowed(
  policy: StdioPolicy,
  command: string,
  args: string[] = [],
  env: Record<string, string> = {}
): string | null {
  if (policy.mode === "off") {
    return (
      "stdio spawning from probe_connect is disabled. It runs an arbitrary local " +
      "command, so the operator must opt in: set MCPROBE_ALLOW_STDIO in the probe's " +
      'environment to the exact command line to allow (e.g. "node /abs/path/server.js"; ' +
      'separate several with ";"), or "*" to allow any command.'
    );
  }
  if (policy.mode === "any") return null;

  const line = normalizeCommandLine([command, ...args].join(" "));
  if (!policy.allowed.includes(line)) {
    return `command line not in MCPROBE_ALLOW_STDIO: ${line}`;
  }
  const risky = Object.keys(env).filter((k) => CODE_LOADING_ENV.test(k));
  if (risky.length > 0) {
    return (
      `env may not set ${risky.join(", ")} when MCPROBE_ALLOW_STDIO is an allowlist ` +
      "(these variables can load arbitrary code)"
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// URL guard (SSRF)
// ---------------------------------------------------------------------------

export interface UrlPolicy {
  /** Allow loopback and private-network addresses (local dev servers). */
  allowPrivate: boolean;
}

export function readUrlPolicy(env: NodeJS.ProcessEnv = process.env): UrlPolicy {
  const v = (env.MCPROBE_ALLOW_PRIVATE_URLS ?? "").trim().toLowerCase();
  return { allowPrivate: v === "1" || v === "true" || v === "yes" };
}

type AddressClass = "public" | "private" | "linkLocal";

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return nums.every((n) => n >= 0 && n <= 255) ? nums : null;
}

function classifyIPv4(ip: string): AddressClass {
  const o = parseIPv4(ip);
  if (!o) return "private"; // unparseable: fail closed
  const [a, b] = o as [number, number, number, number];
  if (a === 169 && b === 254) return "linkLocal"; // incl. cloud metadata 169.254.169.254
  if (a === 0 || a === 127 || a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private"; // CGNAT
  if (a >= 224) return "private"; // multicast / reserved / broadcast
  return "public";
}

/** Classify an IP literal (v4 or v6). Exported for tests. */
export function classifyAddress(ip: string): AddressClass {
  const host = ip.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host) === 4) return classifyIPv4(host);
  if (isIP(host) !== 6) return "private"; // not an IP: fail closed

  // IPv4-mapped / -compatible (::ffff:10.0.0.1, ::ffff:a00:1) — judge the v4 part.
  const mapped = host.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return classifyIPv4(mapped[1]);
  const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex?.[1] && mappedHex[2]) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return classifyIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (host === "::" || host === "::1") return "private";
  if (/^fe[89ab]/.test(host)) return "linkLocal"; // fe80::/10
  if (/^f[cd]/.test(host)) return "private"; // fc00::/7 unique-local
  if (/^ff/.test(host)) return "private"; // multicast
  return "public";
}

const BLOCKED_HOSTNAMES = /^(localhost|.*\.localhost|metadata\.google\.internal|metadata)$/i;

/**
 * Refuse a URL that points somewhere an agent should not be able to reach
 * through the probe: non-http(s) schemes, cloud metadata / link-local
 * addresses (always), and loopback / private networks (unless the operator
 * allows them). Hostnames are resolved and every address is checked.
 *
 * DNS can change between this check and the connection (rebinding); the
 * guarded fetch re-checks each request to narrow that window.
 */
export async function assertPublicUrl(
  raw: string,
  policy: UrlPolicy,
  resolve: (host: string) => Promise<string[]> = defaultResolve
): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`url scheme ${url.protocol} is not allowed (use http or https)`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(host) !== 0;

  if (!literal && BLOCKED_HOSTNAMES.test(host)) {
    if (/metadata/i.test(host) || !policy.allowPrivate) {
      throw new Error(
        `url host ${host} is a local or metadata address` +
          (policy.allowPrivate ? "" : " (set MCPROBE_ALLOW_PRIVATE_URLS=1 to audit a local server)")
      );
    }
    return;
  }

  const addresses = literal ? [host] : await resolve(host);
  if (addresses.length === 0) throw new Error(`could not resolve ${host}`);
  for (const addr of addresses) {
    const cls = classifyAddress(addr);
    if (cls === "linkLocal") {
      throw new Error(`url host ${host} resolves to a link-local/metadata address`);
    }
    if (cls === "private" && !policy.allowPrivate) {
      throw new Error(
        `url host ${host} resolves to a loopback/private address ` +
          "(set MCPROBE_ALLOW_PRIVATE_URLS=1 to audit a local server)"
      );
    }
  }
}

async function defaultResolve(host: string): Promise<string[]> {
  const res = await lookup(host, { all: true });
  return res.map((r) => r.address);
}

/**
 * A fetch for the HTTP transports that re-checks every request URL against
 * the policy and refuses redirects (a public URL could 302 to an internal
 * one). Pass it as `connectHttp({ fetch })`.
 */
export function guardedFetch(
  policy: UrlPolicy,
  base: FetchLike = fetch as unknown as FetchLike
): FetchLike {
  return async (input, init) => {
    const href = typeof input === "string" ? input : input.href;
    await assertPublicUrl(href, policy);
    return base(input, { ...(init ?? {}), redirect: "error" });
  };
}
