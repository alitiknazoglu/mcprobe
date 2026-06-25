# MCProbe

> A stdio MCP server that audits other MCP servers over the live protocol.
> It connects to any MCP target (stdio or HTTP), lints every tool's schema for
> agent-usability, **then actually calls the tools with deliberately broken
> inputs** to see how the server handles them, and returns a 0–100
> conformance score with a per-dimension breakdown rendered as Markdown.

The behavioral pass is the part that matters. Static schema audits tell you
that a tool exists and looks reasonable. MCProbe then picks up a phone and
*dials* each tool with `missing_required`, `wrong_type`, `out_of_enum`, and
`extra_garbage` inputs — the same mistakes a language model will make on a
bad day — and classifies the response. A server that returns a clean
`isError: true` rejected the input correctly. A server that says "OK" to
garbage (silently accepted it) or crashes the JSON-RPC transport both
*failed to reject it* — and the Error Handling score is the fraction of
bad inputs the server rejected cleanly.

## Problem statement

The Model Context Protocol is new. Servers proliferate. Most ship with
tool schemas that an agent can call, but few ship with tool schemas that
an agent can call *correctly*: parameters are untyped, descriptions are
missing, names are not `snake_case`, and a quick look at the code reveals
that the handler is doing `Number(x) / Number(y)` with no guard at all.

The convention in the wider ecosystem is to ship a static schema audit
that flags the obvious smells and then declare the server ready. The
smells are real, but a static audit cannot tell you whether the server
*behaves*: it cannot tell you that `divide("x", "y")` silently returns
`NaN`, or that an extra unknown key is just stripped and ignored.

MCProbe does both, on a single connection:

1. **Static lint.** Twelve rules over every tool's schema: missing or
   thin descriptions, duplicate or unusual names, an empty or
   non-object schema, untyped or undocumented parameters, and a
   server-wide rule for "I said I had tools but I have none."
2. **Behavioral fuzz.** For each tool, the generator produces one valid
   case and at least three malformed variants, calls the target over
   the live JSON-RPC transport, and classifies the outcome as
   `ok` (the tool shrugged), `toolError` (graceful rejection), or
   `protocolCrash` (worst case). A malformed case that comes back
   without `isError: true` is flagged as `silentlyAccepted` — exactly
   the failure mode the linter cannot see.
3. **Scoring.** The findings and the fuzz results are combined into a
   0–100 score on four dimensions, mapped to an A–F grade, and
   rendered as a Markdown report the host (or a human) can read.

## Install

```bash
npm install
npm run build     # tsc -p tsconfig.json && tsc -p examples/demo-target/tsconfig.json
```

The build emits:

- `dist/index.js` — the probe (run this as a stdio MCP server).
- `examples/demo-target/dist/index.js` — a deliberately flawed MCP
  server used by the tests and the demo.

To launch the probe as a stdio MCP server so any host can talk to it:

```bash
npm start
```

No port, no daemon, no config file. The probe speaks JSON-RPC on
stdin/stdout and writes operator logs to stderr.

## Quickstart — audit any MCP server

Two ways to point MCProbe at a target. You only ever register *MCProbe*;
it dials the target itself, so the target needs no setup.

### Option 1 — from an MCP client (Claude Desktop, Cursor, any host)

Add MCProbe to your client's MCP config (use the absolute path to the
built `dist/index.js`):

```json
{
  "mcpServers": {
    "mcprobe": {
      "command": "node",
      "args": ["/absolute/path/to/mcprobe/dist/index.js"]
    }
  }
}
```

Then ask in plain English:

> Use mcprobe to audit `https://docs.base.org/mcp` over http — connect,
> then run a full report with fuzz and show me the score.

The host calls `probe_connect` then `probe_report` for you. MCProbe also
advertises server `instructions`, so the model is told the flow on
connect — no need to memorise the tool names.

### Option 2 — no host, pure terminal

First, get the project and build it:

```bash
git clone https://github.com/alitiknazoglu/mcprobe
cd mcprobe
npm install
npm run build
```

**Step 1 — create the script.** Paste this whole block into your
terminal (still inside the `mcprobe` folder). It writes the file for you
— don't paste the JavaScript directly into the shell, or it will error:

```bash
cat > audit.mjs <<'EOF'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const client = new Client({ name: "runner", version: "1.0.0" }, { capabilities: {} });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));
const call = async (n, a) => (await client.callTool({ name: n, arguments: a })).content.map(c => c.text).join("\n");
console.log(await call("probe_connect", { transport: "http", url: "https://docs.base.org/mcp" }));
console.log(await call("probe_report", { fuzz: true }));
await client.close(); process.exit(0);
EOF
```

**Step 2 — run it:**

```bash
node audit.mjs
```

Swap the `url` (or use `transport: "stdio", command, args`) to audit any
other target.

`fuzz: false` runs a read-only static audit (metadata + schema quality
only). `fuzz: true` also **calls the target's tools with malformed
inputs** to score error handling and liveness. Tools the target marks
`destructiveHint: true` are skipped by default (pass `fuzzDestructive:
true` to include them), so a default fuzz run is safe even against
servers you don't control.

## The six `probe_*` tools

MCProbe registers four core tools and two optional helpers. The core
four cover the full lint → fuzz → score pipeline; the two helpers
cover the everyday ergonomics of managing connections.

| Tool | Purpose | Returns |
| --- | --- | --- |
| `probe_connect` | Open a connection to a target. | `{ connectionId, name, version, capabilities, counts, defaultConnectionId }` |
| `probe_lint` | Run the 12 lint rules over the target's cached tool summaries. | `{ connectionId, server, findings, summary }` |
| `probe_fuzz` | Generate valid + malformed inputs per tool, call each, classify the outcome. Skips destructive tools by default. | `{ connectionId, server, results, coverage, summary }` |
| `probe_report` | Run lint (and fuzz when requested), score, render Markdown. | `{ connectionId, server, overall, grade, dimensions, coverage, findings, fuzz, markdown }` |
| `probe_list` | (optional) Enumerate the target's tools. | `{ connectionId, server, tools }` |
| `probe_disconnect` | (optional) Close one connection (by id) or every connection. | `{ removed, remaining, defaultConnectionId }` |

All tools default to the most recently opened connection when
`connectionId` is omitted, so a single-target audit is a three-call
sequence: `probe_connect` → `probe_report` → `probe_disconnect`.

Every tool also declares MCP **annotations** so a host can reason about
side effects before calling: `probe_lint` and `probe_list` are
`readOnlyHint: true`, while `probe_fuzz` is `destructiveHint: true`
(it invokes the target's tools), and the tools that reach a target
(`probe_connect`, `probe_fuzz`, `probe_report`) set `openWorldHint: true`.
MCProbe audits other servers for agent-usability, so it declares these
hints on its own tools too.

### `probe_connect`

Two transports: `stdio` (spawns a child process) and `http` (speaks
the streamable HTTP transport, with SSE fallback). For `stdio`,
`command` is required; for `http`, `url` is required. The target's
`initialize` handshake is run synchronously, the server's identity
and capabilities are cached, and a stable `connectionId` is returned.

### `probe_lint`

A pure pass over the connection's cached tool summaries — no extra
round-trip. Each finding carries a stable `code`, a `severity`
(`error`, `warning`, `info`), a human-readable `message`, a
`location` (`{ tool, param? }`), and a `hint` with a concrete fix.

The twelve rules are:

| Code | Severity | What it catches |
| --- | --- | --- |
| `tool.missing_description` | error | A tool with no description at all. |
| `tool.thin_description` | warning | A description under 12 characters. |
| `tool.duplicate_name` | error | Two tools registered with the same name. |
| `tool.unusual_name` | warning | A name that is not `snake_case` or `kebab-case`. |
| `tool.no_input_schema` | warning | An empty or missing `inputSchema`. |
| `tool.no_annotations` | info | A tool that declares no MCP annotations (`readOnlyHint`, `destructiveHint`, etc.). |
| `schema.invalid` | error | A schema that fails to compile (Ajv). |
| `schema.root_not_object` | warning | A root `type` that is not `object`. |
| `schema.no_required` | info | Properties declared but no `required` array. |
| `param.untyped` | warning | A property with no `type`/`enum`/`const`/`oneOf`. |
| `param.missing_description` | warning | A property with no `description`. |
| `server.no_tools` | warning | The server claims `tools` but registers none. |

### `probe_fuzz`

For every tool (capped at `maxTools`, default 10), the generator
emits one valid case and at least three malformed variants:

- `missing_required:<field>` — drop each required field in turn.
- `wrong_type:<field>` — replace each typed field with a value of a
  different primitive type.
- `out_of_enum:<field>` — for `enum` or `const` fields, send a value
  the schema forbids.
- `extra_garbage` — append a sentinel key to the valid args.

Each case is sent to the target over the live JSON-RPC transport.
The classifier assigns one of three outcomes:

| Outcome | Meaning |
| --- | --- |
| `ok` | The target returned a result with `isError: false`. For a malformed case this is `silentlyAccepted: true`. |
| `toolError` | The target returned a result with `isError: true` (graceful rejection). |
| `protocolCrash` | The call rejected or the transport closed. |

**Dry-run safety.** By default, tools annotated `destructiveHint: true`
are **not** fuzzed — so pointing MCProbe at a server you don't control
can't trigger a real destructive action (e.g. a `delete_file` tool).
Pass `fuzzDestructive: true` to override. `probe_fuzz` (and the report)
return a **coverage** summary listing how many tools were fuzzed and
which were skipped (as destructive, or over the `maxTools` cap).

### `probe_report`

The convenience entry point. Calls `probe_lint` (always) and
`probe_fuzz` (when `fuzz: true`), scores the result on the four
dimensions described below, and returns the structured
`ConformanceReport` *and* a rendered Markdown string. The
Markdown is the canonical payload; downstream tools that need the
numbers can pull them out of the structured fields.

## Scoring model — four dimensions

The overall 0–100 score is the mean of the *measured* dimensions.
Dimensions that were not measured (e.g. the two behavioral ones when
`fuzz: false`, or when every tool was skipped) are reported as "not
measured" and excluded from the average rather than penalized with a
fake value. This is what lets a static audit of a clean server still
score 100/100.

The two **static** dimensions are subtractive (start at 10, lose points
per finding). The two **behavioral** dimensions are **normalized rates**,
so a score is comparable across servers of different sizes — and the
fuzz cases are partitioned by kind (malformed → Error Handling, valid →
Liveness) so no outcome is ever counted twice.

Letter grades: A ≥ 90, B ≥ 75, C ≥ 60, D ≥ 40, F < 40.

| Dimension | Always measured? | What it captures |
| --- | --- | --- |
| **Metadata & Documentation** | yes | Server identity (name, version), advertised capabilities, presence of `instructions` (+1 bonus). |
| **Schema Quality** | yes | Subtractive: 1 per `error`, 0.5 per `warning`, 0.25 per `info` finding. |
| **Error Handling** | only with `fuzz: true` | Rate over **malformed** cases: `10 × (gracefully-rejected / total malformed)`. A silent accept (garbage let through) or a protocol crash both count as failed rejections. |
| **Liveness & Performance** | only with `fuzz: true` | Rate over **valid** cases: `10 × (successful / total valid)`, minus 0.5 per 100ms that the valid-call p50 latency exceeds a 200ms target. |

The per-dimension reasons and counts are emitted in the Markdown report
so the score is auditable by a human. When fuzzing runs, the report
header also shows two extra lines:

- a **Coverage** line (how many tools were fuzzed, and which were skipped
  as destructive or over the `maxTools` cap); and
- a **critical-issues callout** — a flag, *not* a second score — hoisting
  the dangerous findings to the top, e.g. `⚠ Critical: 4 tool(s) silently
  accept malformed input (…); 1 protocol crash(es)`, or `✓ No critical
  behavioral issues` when there are none. The normalized scores are
  unchanged; this just makes the scary stuff visible above the fold.

## 30-second demo

The probe ships with a deliberately flawed demo target at
`examples/demo-target/` and a smoke script that runs the full
`probe_report` pipeline against it. From a clean clone:

```bash
npm install
npm run build
node scripts/smoke-report.mjs
```

The script spawns the probe as a stdio MCP server, opens a
connection to the demo target, calls `probe_report` with
`fuzz: true`, and prints the Markdown report to stdout. The demo
target is wired to fail loudly: `greet` has no description,
`divide` returns `NaN` on bad input, `set_mode` has a thin
description, and `well_behaved` is the only clean tool. The report
will show a low overall score with concrete findings and a fuzz
table that classifies the broken cases.

For an interactive tour, the official MCP inspector works as a
host against the built probe:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

The inspector UI lists the six `probe_*` tools; calling them
manually is a good way to see the request/response shape.

## External server example

For a full `probe_connect` → `probe_report` → `probe_disconnect`
walkthrough as an AI agent would run it (natural-language request, the
JSON tool calls, and the rendered report), see
[examples/agent-usage.md](examples/agent-usage.md).

The probe is not coupled to the demo target. To audit any other
MCP server, swap the `command`/`args` in `probe_connect`:

```jsonc
// tool call: probe_connect
{
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem@latest", "/tmp"]
}
```

The probe runs the initialize handshake against the spawned
process, caches its tools, and is ready for `probe_lint` /
`probe_fuzz` / `probe_report`. The same pattern works for HTTP
targets: pass `transport: "http"` and a `url` instead.

A real transcript of this audit (run against
`@modelcontextprotocol/server-filesystem@latest` and saved to
`examples/transcripts/external-server.md`) is included in the
repository. The script that produced it is
`scripts/external-audit.mjs`. A self-audit (a second copy of the
probe scoring the first) lives at
`examples/transcripts/self-audit.md`.

## Architecture

MCProbe plays two roles at once: it is a stdio MCP server to its
host, and an MCP *client* to whatever it is auditing. The split
mirrors the source layout.

```
+-------------------------------------------------+
| any MCP client over stdio:                      |
| Claude Code, an IDE, an agent, or a node script |
+-------------------------------------------------+
                          |
                          |  stdio JSON-RPC  (stdin / stdout)
                          v
+--------------------------------------------------+
|  MCProbe  -  one stdio MCP server                |
|                                                  |
|  src/index.ts       registers the probe_* tools  |
|      |  then calls the pure modules:             |
|      +--> src/schema-lint   (12 lint rules)      |
|      +--> src/fuzz          (case generator)     |
|      +--> src/conformance   (4-dimension score)  |
|      +--> src/report        (markdown renderer)  |
|      |                                           |
|      v                                           |
|  src/target-client  (outbound MCP client)        |
+--------------------------------------------------+
                          |
                          |  stdio / http JSON-RPC
                          v
              +---------------------+
              |  target MCP server  |
              +---------------------+
```

The top box is whatever drives MCProbe over stdio — a full host like
Claude Code, **or a plain `node` script** (the `scripts/*.mjs` drivers
and the Quickstart's `audit.mjs` are exactly this; no host required).
It talks only to MCProbe; MCProbe's `src/target-client` then dials the
audited server over stdio or http. The probe sits in the middle — a
server to its caller, a client to its target.

| Module | Role | I/O? |
| --- | --- | --- |
| `src/types.ts` | Shared `Finding`, `FuzzResult`, `DimensionScore`, `ConformanceReport` types. | none |
| `src/target-client.ts` | Outbound MCP client, `ConnectionRegistry`, `callTool` wrapper that catches transport errors. | yes — spawns / dials |
| `src/schema-lint.ts` | The 12 lint rules. Pure: no I/O, deterministic ordering. | none |
| `src/fuzz.ts` | Case generator + runner + `summarizeFuzz` histogram. Generator is pure; runner threads through a caller-supplied `call` fn so it stays unit-testable. | none on the generator; the runner calls the target |
| `src/conformance.ts` | Per-dimension scoring + rollup. Pure. | none |
| `src/report.ts` | Pure Markdown renderer. Same input → same output every run. | none |
| `src/index.ts` | `McpServer`, registers the six `probe_*` tools, routes them to the pure modules. | yes — owns the stdio transport |

The four pure modules (`schema-lint`, `fuzz` generator,
`conformance`, `report`) are deliberately side-effect-free so the
vitest suite can exercise them in milliseconds without spawning a
target. The integration test in `tests/demo-target.test.ts` is the
only piece that touches a live process; it is the smallest test
that proves the build artifact loads over the real protocol.

## Limitations

- **The four runtime dependencies are frozen.** `@modelcontextprotocol/sdk`,
  `ajv`, `ajv-formats`, `zod`. The probe deliberately does not
  depend on any CLI framework, HTTP server, or transport library
  beyond what the SDK already exposes. Adding a runtime dependency
  is an explicit change to the spec.
- **The probe is a stdio MCP server, full stop.** It does not
  expose an HTTP endpoint. Run it as a subprocess of your host.
- **The fuzzer is shallow, not adversarial.** It exercises the
  surface documented by the tool's `inputSchema`; it does not
  attempt to discover server-side bugs that are out of band of
  the tool contract. The point of MCProbe is conformance, not
  general-purpose server fuzzing.
- **The scoring is dimension-local.** A perfect score on one dimension
  does not rescue a failure on another. The static dimensions are
  subtractive; the behavioral dimensions are normalized rates. The four
  dimensions are weighted equally when measured.
- **Dry-run skips destructive tools.** By default a fuzz run does not
  exercise tools annotated `destructiveHint: true`; they show up in the
  coverage summary as skipped. A target that *doesn't* annotate a
  destructive tool will still be fuzzed — annotations are the only
  signal MCProbe has. Pass `fuzzDestructive: true` to fuzz everything.
- **Behavioral scores need a real protocol round-trip.** When
  `fuzz: false` is passed to `probe_report`, the `Error Handling`
  and `Liveness & Performance` dimensions are reported as
  "not measured" and excluded from the rollup. A "lint-only"
  audit can still score 100/100 on a clean server, but it cannot
  tell you whether the server would survive a bad input.
- **Tooling is four cores + two helpers, no more.** The spec
  pins the surface area. Adding a `probe_*` tool is an explicit
  change to the spec.
- **The optional helpers are still required at startup.** The
  `McpServer` is constructed with the `tools` capability only;
  it does not advertise `resources` or `prompts`. The probe
  itself is an audit tool, not a content server.
