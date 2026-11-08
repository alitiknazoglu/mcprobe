// Command-line interface for MCProbe.
//
//   mcprobe audit <url>                      static audit of an HTTP server
//   mcprobe audit <url> --fuzz               + behavioral fuzzing
//   mcprobe audit <url> --bearer <token>     audit a server that needs a key
//   mcprobe audit --stdio "npx my-server"    audit a local stdio server
//   mcprobe push  <target> --token <key>     run the audit and upload it
//   mcprobe serve                            run the MCP server (default)
//
// `audit` prints the Markdown report to stdout. `push` runs the same audit and
// POSTs the report JSON to an ingest endpoint with a bearer token — the endpoint
// (default https://mcprobe.org/api/ingest) decides what to do with it. There is
// no entitlement logic here; the server enforces that.
//
// This module owns stdout in CLI mode. The MCP server (index.ts) keeps stdout
// for its JSON-RPC stream and is reached via `serve` or no arguments.

import { auditUrl, auditStdio } from "./audit.js";
import { renderReport } from "./report.js";
import { redactUrl } from "./target-client.js";
import type { ConformanceReport } from "./types.js";

const DEFAULT_ENDPOINT = "https://mcprobe.org/api/ingest";

interface CliArgs {
  url?: string;
  stdio?: string;
  fuzz: boolean;
  fuzzDestructive: boolean;
  fuzzUnannotated: boolean;
  json: boolean;
  token?: string;
  to?: string;
  /** Headers sent to the *target* server — distinct from `token`, which
   *  authenticates us to the ingest endpoint. Keeping these separate matters:
   *  handing an MCProbe token to a third-party target would leak it. */
  headers?: Record<string, string>;
  /** `--env NAME=VALUE` — set on a stdio target's environment. */
  env?: Record<string, string>;
  /** `--pass-env NAME` — forward a variable from this process to a stdio target. */
  passEnv?: string[];
}

/** Parse a `--env NAME=VALUE` argument. */
function parseEnvArg(raw: string | undefined): [string, string] {
  const at = raw?.indexOf("=") ?? -1;
  if (!raw || at <= 0) {
    throw new Error(`--env expects NAME=VALUE (got: ${raw ?? "nothing"})`);
  }
  return [raw.slice(0, at), raw.slice(at + 1)];
}

/** Parse a `--header "Name: Value"` argument. */
function parseHeaderArg(raw: string | undefined): [string, string] {
  const at = raw?.indexOf(":") ?? -1;
  if (!raw || at <= 0) {
    throw new Error(`--header expects "Name: Value" (got: ${raw ?? "nothing"})`);
  }
  return [raw.slice(0, at).trim(), raw.slice(at + 1).trim()];
}

/** Parse CLI flags. Exported for tests. */
export function parseArgs(
  rest: string[],
  env: NodeJS.ProcessEnv = process.env
): CliArgs {
  const out: CliArgs = {
    fuzz: false,
    fuzzDestructive: false,
    fuzzUnannotated: false,
    json: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === undefined) continue;
    if (a === "--fuzz") out.fuzz = true;
    else if (a === "--fuzz-destructive") {
      out.fuzz = true;
      out.fuzzDestructive = true;
    } else if (a === "--fuzz-unannotated") {
      out.fuzz = true;
      out.fuzzUnannotated = true;
    } else if (a === "--json") out.json = true;
    else if (a === "--stdio") out.stdio = rest[++i];
    else if (a === "--token") out.token = rest[++i];
    else if (a === "--to") out.to = rest[++i];
    else if (a === "--bearer") {
      const t = rest[++i];
      if (t) (out.headers ??= {})["Authorization"] = `Bearer ${t}`;
    } else if (a === "--header") {
      const [name, value] = parseHeaderArg(rest[++i]);
      (out.headers ??= {})[name] = value;
    } else if (a === "--env") {
      const [name, value] = parseEnvArg(rest[++i]);
      (out.env ??= {})[name] = value;
    } else if (a === "--pass-env") {
      const name = rest[++i];
      if (!name) throw new Error("--pass-env expects a variable name");
      (out.passEnv ??= []).push(name);
    } else if (!a.startsWith("-") && !out.url) out.url = a; // positional URL
  }
  // Env fallback keeps the credential out of shell history. Explicit flags win.
  // HTTP targets only: a stdio target takes credentials via its own env, and
  // applying this to --stdio made every stdio audit fail while it was set.
  const envToken = env.MCPROBE_TARGET_TOKEN;
  if (envToken && !out.stdio && !out.headers?.["Authorization"]) {
    (out.headers ??= {})["Authorization"] = `Bearer ${envToken}`;
  }
  return out;
}

async function runAudit(args: CliArgs): Promise<ConformanceReport> {
  const opts = {
    fuzz: args.fuzz,
    fuzzDestructive: args.fuzzDestructive,
    fuzzUnannotated: args.fuzzUnannotated,
  };
  if (args.stdio) {
    if (args.headers) {
      throw new Error(
        "--bearer/--header apply to HTTP targets; a stdio server takes credentials via its own env"
      );
    }
    const parts = splitCommandLine(args.stdio);
    const command = parts[0];
    if (!command) throw new Error('--stdio needs a command, e.g. --stdio "npx my-server"');
    return auditStdio(command, {
      ...opts,
      args: parts.slice(1),
      env: args.env,
      passEnv: args.passEnv,
    });
  }
  if (args.env || args.passEnv) {
    throw new Error("--env/--pass-env apply to --stdio targets");
  }
  if (args.url) return auditUrl(args.url, { ...opts, headers: args.headers });
  throw new Error(
    'no target — pass an HTTPS URL or --stdio "<command>" (e.g. --stdio "npx my-server")'
  );
}

/**
 * Split a `--stdio` command line into argv the way a POSIX shell would for
 * the simple cases: whitespace separates words, '…' is literal, "…" allows
 * \" and \\ escapes, and a backslash outside quotes escapes the next char.
 * No expansion of variables, globs or `~`. Exported for tests.
 */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && (line[i + 1] === '"' || line[i + 1] === "\\")) cur += line[++i];
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === "\\" && i + 1 < line.length) {
      cur += line[++i];
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) out.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (quote) throw new Error(`--stdio has an unterminated ${quote} quote`);
  if (inWord) out.push(cur);
  return out;
}

/** Flags / env names whose value is a secret. */
const SECRET_NAME =
  /(api[-_]?key|token|secret|passw(or)?d|pwd|auth|credential|private[-_]?key|bearer|session|cookie|signature)/i;

/** Values that look like a credential on their own (vendor-prefixed keys,
 *  JWTs, long opaque alphanumeric strings — no "/" so paths survive). */
const SECRET_VALUE = new RegExp(
  [
    "^(?:(?:sk|pk|rk)[-_]|gh[pousr]_|github_pat_|xox[abprs]-|glpat-|npm_|mcp_)[A-Za-z0-9_-]{8,}$",
    "^(?:AKIA|ASIA)[A-Z0-9]{12,}$",
    "^AIza[A-Za-z0-9_-]{20,}$",
    "^eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.", // JWT
    "^(?=.*\\d)(?=.*[A-Za-z])[A-Za-z0-9+_=-]{32,}$",
  ].join("|")
);

/**
 * Describe the audited target for upload without leaking secrets in it: a
 * stdio command line often carries a key (`--api-key sk_…`, `TOKEN=…`), and a
 * URL can embed credentials. Values after secret-named flags, secret-named
 * `NAME=value` pairs, credential-shaped values and URL credentials are
 * replaced with `***`; the home directory becomes `~`. Exported for tests.
 */
export function describeTargetForUpload(
  args: Pick<CliArgs, "stdio" | "url">,
  home: string | undefined = process.env.HOME
): string {
  if (!args.stdio) return redactUrl(args.url ?? "");
  let parts: string[];
  try {
    parts = splitCommandLine(args.stdio);
  } catch {
    parts = args.stdio.trim().split(/\s+/);
  }
  const out: string[] = [];
  let redactNext = false;
  for (const raw of parts) {
    let p = raw;
    if (redactNext) {
      out.push("***");
      redactNext = false;
      continue;
    }
    const flag = p.match(/^(--?[A-Za-z0-9][\w.-]*)(=(.*))?$/);
    const assign = p.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (flag && SECRET_NAME.test(flag[1] as string)) {
      if (flag[2] === undefined) redactNext = true;
      else p = `${flag[1]}=***`;
    } else if (assign && SECRET_NAME.test(assign[1] as string)) {
      p = `${assign[1]}=***`;
    } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) {
      p = redactUrl(p);
    } else if (SECRET_VALUE.test(p)) {
      p = "***";
    }
    if (home && home.length > 1 && p.includes(home)) p = p.split(home).join("~");
    out.push(/\s/.test(p) ? JSON.stringify(p) : p);
  }
  return `stdio: ${out.join(" ")}`;
}

/** The ingest endpoint receives the bearer token, so it must be https.
 *  Plain http is allowed only to loopback, for local development. */
export function checkEndpoint(endpoint: string): string | null {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return `invalid ingest endpoint: ${redactUrl(endpoint)}`;
  }
  if (u.protocol === "https:") return null;
  const loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(u.host.replace(/:\d+$/, ""));
  if (u.protocol === "http:" && loopback) return null;
  return `refusing to send the token to a non-https endpoint: ${redactUrl(endpoint)} (use https://, or http:// only to localhost)`;
}

/** Run the CLI. Returns a process exit code. */
export async function runCli(argv: string[]): Promise<number> {
  const cmd = argv[0];

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return cmd ? 0 : 1;
  }

  if (cmd !== "audit" && cmd !== "push") {
    process.stderr.write(`mcprobe: unknown command "${cmd}"\n\n`);
    printHelp();
    return 2;
  }

  let args: CliArgs;
  try {
    args = parseArgs(argv.slice(1));
  } catch (err) {
    process.stderr.write(`mcprobe: ${(err as Error).message}\n`);
    return 2;
  }

  // For push, fail fast on a missing token before spawning/auditing anything.
  const endpoint = args.to || process.env.MCPROBE_API || DEFAULT_ENDPOINT;
  const token = args.token || process.env.MCPROBE_TOKEN;
  if (cmd === "push" && !token) {
    process.stderr.write(
      "mcprobe: a token is required to push.\n" +
        "  Pass --token <key> or set MCPROBE_TOKEN.\n" +
        "  Create your key at https://mcprobe.org/app/profile\n"
    );
    return 2;
  }
  if (cmd === "push") {
    const bad = checkEndpoint(endpoint);
    if (bad) {
      process.stderr.write(`mcprobe: ${bad}\n`);
      return 2;
    }
  }

  let report: ConformanceReport;
  try {
    report = await runAudit(args);
  } catch (err) {
    process.stderr.write(`mcprobe: ${(err as Error).message}\n`);
    return 1;
  }

  if (cmd === "audit") {
    // --json emits the machine-readable report (for CI gating / tooling);
    // otherwise the human-readable Markdown report.
    process.stdout.write(
      (args.json ? JSON.stringify(report, null, 2) : renderReport(report)) + "\n"
    );
    return 0;
  }

  // push: upload the report to the ingest endpoint.
  // Never upload a raw command line or URL: either can carry a credential.
  const target = describeTargetForUpload(args);
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        report,
        target,
        transport: args.stdio ? "stdio" : "http",
        fuzzed: args.fuzz,
      }),
    });
  } catch (err) {
    process.stderr.write(`mcprobe: upload failed — ${(err as Error).message}\n`);
    return 1;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    process.stderr.write(
      `mcprobe: upload rejected (${res.status} ${res.statusText})` +
        (body ? ` — ${body}` : "") +
        "\n"
    );
    return 1;
  }

  const data = (await res.json().catch(() => ({}))) as { url?: string };
  process.stderr.write(`✓ uploaded — ${data.url ?? redactUrl(endpoint)}\n`);
  // --json emits the full report (parity with `audit --json`); otherwise the
  // short score line. The "uploaded" note above always goes to stderr.
  process.stdout.write(
    (args.json ? JSON.stringify(report, null, 2) : `${report.overall}/100 (${report.grade})`) + "\n"
  );
  return 0;
}

function printHelp(): void {
  process.stderr.write(
    `mcprobe — audit MCP servers (conformance score 0–100)

Usage:
  mcprobe audit <https-url> [--fuzz]
  mcprobe audit --stdio "<command>" [--fuzz]
  mcprobe push  <target> --token <key> [--fuzz] [--to <url>]
  mcprobe serve            run the MCP server (also the default with no args)
  mcprobe help

Examples:
  mcprobe audit https://docs.base.org/mcp --fuzz
  mcprobe audit --stdio "npx @acme/my-mcp-server" --fuzz
  mcprobe audit https://api.acme.com/mcp --bearer sk_live_xxx --fuzz
  mcprobe push  --stdio "npx @acme/my-mcp-server" --fuzz --token mcp_xxx

Flags:
  --fuzz                call each tool with valid + malformed input (behavioral
                        test). Only tools annotated readOnlyHint:true or
                        destructiveHint:false — every fuzzed tool runs for real
  --fuzz-unannotated    also fuzz tools with no safety annotations (implies --fuzz)
  --fuzz-destructive    fuzz every tool, even ones marked destructive (implies
                        --fuzz-unannotated)
  --json                (audit/push) print the report as JSON instead of Markdown
  --stdio "<command>"   audit a local stdio server instead of a URL
  --bearer <token>      credential for the TARGET server (sends Authorization: Bearer)
  --header "N: V"       arbitrary header for the TARGET server (repeatable)
  --env NAME=VALUE      (stdio) set a variable on the target's environment (repeatable)
  --pass-env NAME       (stdio) forward NAME from this shell to the target (repeatable)
  --token <key>         (push) bearer token for the MCProbe ingest endpoint
  --to <url>            (push) ingest endpoint, https only (default ${DEFAULT_ENDPOINT})

  Note: --bearer/--header authenticate you to the server being audited;
  --token authenticates you to MCProbe. Never pass your MCProbe token as
  --bearer — it would be sent to the audited server.

  A stdio target does NOT inherit this shell's environment — it gets only
  PATH/HOME/USER/SHELL/TERM plus what you pass with --env / --pass-env, so
  MCPROBE_TOKEN and CI secrets never reach the audited process.

Env: MCPROBE_TOKEN (ingest), MCPROBE_TARGET_TOKEN (target server), MCPROBE_API
`
  );
}
