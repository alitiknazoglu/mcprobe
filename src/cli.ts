// Command-line interface for MCProbe.
//
//   mcprobe audit <url>                      static audit of an HTTP server
//   mcprobe audit <url> --fuzz               + behavioral fuzzing
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
import type { ConformanceReport } from "./types.js";

const DEFAULT_ENDPOINT = "https://mcprobe.org/api/ingest";

interface CliArgs {
  url?: string;
  stdio?: string;
  fuzz: boolean;
  fuzzDestructive: boolean;
  json: boolean;
  token?: string;
  to?: string;
}

function parseArgs(rest: string[]): CliArgs {
  const out: CliArgs = { fuzz: false, fuzzDestructive: false, json: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === undefined) continue;
    if (a === "--fuzz") out.fuzz = true;
    else if (a === "--fuzz-destructive") {
      out.fuzz = true;
      out.fuzzDestructive = true;
    } else if (a === "--json") out.json = true;
    else if (a === "--stdio") out.stdio = rest[++i];
    else if (a === "--token") out.token = rest[++i];
    else if (a === "--to") out.to = rest[++i];
    else if (!a.startsWith("-") && !out.url) out.url = a; // positional URL
  }
  return out;
}

async function runAudit(args: CliArgs): Promise<ConformanceReport> {
  const opts = { fuzz: args.fuzz, fuzzDestructive: args.fuzzDestructive };
  if (args.stdio) {
    const parts = args.stdio.trim().split(/\s+/).filter(Boolean);
    const command = parts[0];
    if (!command) throw new Error('--stdio needs a command, e.g. --stdio "npx my-server"');
    return auditStdio(command, { ...opts, args: parts.slice(1) });
  }
  if (args.url) return auditUrl(args.url, opts);
  throw new Error(
    'no target — pass an HTTPS URL or --stdio "<command>" (e.g. --stdio "npx my-server")'
  );
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

  const args = parseArgs(argv.slice(1));

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
  const target = args.stdio ? `stdio: ${args.stdio}` : args.url!;
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
  process.stderr.write(`✓ uploaded — ${data.url ?? endpoint}\n`);
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
  mcprobe push  --stdio "npx @acme/my-mcp-server" --fuzz --token mcp_xxx

Flags:
  --fuzz                also call each tool with malformed input (behavioral test)
  --fuzz-destructive    additionally fuzz tools marked destructive (implies --fuzz)
  --json                (audit/push) print the report as JSON instead of Markdown
  --stdio "<command>"   audit a local stdio server instead of a URL
  --token <key>         (push) bearer token for the ingest endpoint
  --to <url>            (push) ingest endpoint (default ${DEFAULT_ENDPOINT})

Env: MCPROBE_TOKEN, MCPROBE_API
`
  );
}
