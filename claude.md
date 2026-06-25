# MCProbe agent conventions

This file is the contract for any agent (human or model) working in the
`mcprobe` repository. It captures the build/test commands, file layout,
naming rules, runtime dependencies, the project terminology, and the
procedure for adding a new lint rule, fuzz case, or `probe_*` tool.
Update this file when conventions change; do not silently drift.

## Build, test, run

| Action | Command |
| --- | --- |
| Install dependencies | `npm install` |
| Build (probe + demo target) | `npm run build` |
| Build only the probe | `npm run build:probe` |
| Build only the demo target | `npm run build:demo` |
| Start the probe over stdio | `npm start` |
| Run the test suite | `npm test` |
| Type-check only (no emit) | `npx tsc --noEmit && (cd examples/demo-target && npx tsc --noEmit)` |
| Type-check the test files | `npx tsc --noEmit -p tsconfig.test.json` |
| Run a single test file | `npx vitest run tests/fuzz.test.ts` |
| Run a single test by name | `npx vitest run -t "primitive=string"` |
| Watch the test suite | `npx vitest` |

`npm test` runs `pretest` first, which is `npm run build`. That means
the demo target is rebuilt and re-emitted before every test run, so
`tests/demo-target.test.ts` always spawns a fresh binary. If you want
to skip the rebuild, run `npx vitest run` directly.

The probe is **stdio-only**. Anything written to stdout in `src/` is a
bug — it would interleave the JSON-RPC stream. Use `console.error` (or
a tiny stderr wrapper) for operator-visible logs. The target's own
stderr is inherited by default so the operator sees target log output
intermixed with the probe's.

## File layout

```
mcprobe/
├── package.json          # ESM, type:module, exactly four runtime deps
├── tsconfig.json         # strict, ES2022, NodeNext, outDir: dist (src/ only)
├── tsconfig.test.json    # strict, includes src/ + tests/ + vitest.config.ts, noEmit
├── vitest.config.ts      # Node env, single-fork pool, 30s timeouts
├── README.md             # behavioral pitch first, then tools/scoring/demo
├── claude.md             # this file
├── src/
│   ├── types.ts          # shared types (Finding, FuzzResult, Score, ...)
│   ├── target-client.ts  # outbound MCP client + ConnectionRegistry
│   ├── schema-lint.ts    # 12 lint rules -> Finding[]
│   ├── fuzz.ts           # JSON-Schema -> valid + malformed cases
│   ├── conformance.ts    # orchestrator + 4-dimension scoring
│   ├── report.ts         # pure Markdown renderer
│   └── index.ts          # McpServer, registers probe_* tools
├── examples/
│   ├── demo-target/      # sibling package, four flawed tools
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/index.ts
│   └── transcripts/      # generated audit reports (one .md per audit)
├── scripts/              # smoke + audit driver scripts
│   ├── smoke-list-tools.mjs
│   ├── smoke-connect.mjs
│   ├── smoke-lint.mjs
│   ├── smoke-fuzz.mjs
│   ├── smoke-report.mjs
│   ├── self-audit.mjs    # drives probe_report against a second copy of itself
│   └── external-audit.mjs # drives probe_report against a third-party MCP server
├── tests/                # vitest suites
│   ├── schema-lint.test.ts  # 12 rules + invariants
│   ├── fuzz.test.ts         # generator, classifier, summarizer, dry-run + coverage
│   ├── conformance.test.ts  # normalized scoring + no-overlap + coverage rendering
│   ├── target-client.test.ts # safeList tolerance (introspection never crashes)
│   └── demo-target.test.ts  # live spawn of examples/demo-target
└── dist/                 # tsc output for the probe (gitignored; produced by `npm run build`)
    └── examples/demo-target/dist/  # tsc output for the demo target
```

Module I/O contract (kept simple on purpose — every pure module is
unit-testable in milliseconds, only `target-client.ts` and `index.ts`
touch the world):

| Module | Pure? | I/O? |
| --- | --- | --- |
| `src/types.ts` | yes | none |
| `src/schema-lint.ts` | yes | none |
| `src/fuzz.ts` (generator + summarizer) | yes | none |
| `src/conformance.ts` | yes | none |
| `src/report.ts` | yes | none |
| `src/target-client.ts` | no | spawns / dials MCP transports |
| `src/index.ts` | no | owns the stdio transport, registers tools |

## Naming rules

- **Tool names** are `snake_case` and start with the `probe_` prefix.
  - Four core: `probe_connect`, `probe_lint`, `probe_fuzz`, `probe_report`.
  - Two optional helpers: `probe_list`, `probe_disconnect`.
- **Finding codes** use dotted form: `tool.missing_description`,
  `param.untyped`, `schema.invalid`, etc. Treat them as a stable
  public contract — never rename. Append-only.
- **Module names** are `kebab-case` where it reads better
  (`schema-lint`, `target-client`), `camelCase` for single-word
  imports.
- **Types** are `PascalCase` (`Finding`, `FuzzResult`,
  `ConformanceReport`).
- **Script names** in `scripts/` are `kebab-case` `.mjs` files
  (`smoke-fuzz.mjs`, `external-audit.mjs`). They drive the probe over
  the real stdio MCP transport from the outside.
- **Test files** in `tests/` end in `.test.ts` and live next to the
  vitest config; vitest's `include` glob picks them up automatically.

## Runtime dependencies (frozen)

Exactly four runtime packages. Do not add more without an explicit
acceptance-criteria change.

| Package | Why |
| --- | --- |
| `@modelcontextprotocol/sdk` | MCP server (probe) and client (target) |
| `ajv` | JSON-Schema compile for the lint rules |
| `ajv-formats` | `date-time`, `uri`, etc. for Ajv |
| `zod` | The probe's own tool input schemas |

`devDependencies` are limited to `typescript` and `vitest`. Do not add
test runners, assertion libraries, mocking frameworks, or HTTP clients
to either list — the four pure modules are testable with `vitest` and
nothing else.

## Terminology

Use these terms in code, docs, tool output, comments, and commit
messages. They are the canonical vocabulary of the project.

- `conformance`, `audit`, `grade` — the project's headline words
- `quality`, `schema quality` — how well-formed a tool's schema is
- `report`, `findings` — the output of an audit
- the 0–100 score and A–F `grade` — the numeric and letter rollups
- `transport` (stdio or http) — how a target is reached
- `severity` (`error` / `warning` / `info`) — per-finding classification
- the `probe_*` prefix for tool names — the four core + two optional helpers

**Always fine:** MCP, tool, schema, JSON Schema, conformance, fuzz,
lint, transport, stdio, capability, severity, finding.

## Adding a new `probe_*` tool

1. Open `src/index.ts` and locate the tool-registration block
   (`server.tool(...)` calls).
2. Append the new registration using the same `server.tool(name,
   description, inputSchema, annotations, handler)` shape. The first
   argument must be `snake_case` and start with `probe_`. Declare the
   tool's behavioral hints in `annotations` (`readOnlyHint`,
   `destructiveHint`, `idempotentHint`, `openWorldHint`) — a tool that
   reaches a target sets `openWorldHint: true`; a pure/cached read sets
   `readOnlyHint: true`; a tool that invokes the target's tools sets
   `destructiveHint: true`.
3. The handler must return a `CallToolResult` (use the local `ok()` /
   `fail()` helpers) and must never throw out — wrap every body in
   `try { ... } catch (err) { return fail(tool, err); }`.
4. The handler must never write to stdout. Use `console.error` for
   operator logs.
5. If the tool persists anything on the `ConnectionRegistry`, update
   the registry's lifecycle in `src/target-client.ts` too.
6. Add a smoke script under `scripts/` that drives the new tool
   against the demo target, and a unit test under `tests/` if any
   pure logic is involved.
7. Update README.md's `## The six \`probe_*\` tools` table to list
   the new tool — and adjust the surrounding sentence that says
   "four core + two optional helpers" if the count changes.
8. Update `scripts/smoke-list-tools.mjs`'s `CORE_TOOLS` / `OPTIONAL_TOOLS`
   arrays — that script asserts the probe advertises exactly those — and
   the "six tools" heading/count in README and claude.md if it changes.

## Adding a new lint rule

1. Open `src/schema-lint.ts`. Each rule lives inside `lintOneTool`
   (for per-tool rules) or `lintTools` (for the server-wide rule).
   The expected pattern is a small `if (...) { out.push({ ... }) }`
   block that returns a `Finding` with the documented shape.
2. Add the rule's `FindingCode` literal to the `FindingCode` union
   in `src/types.ts` (the union is the stable contract — append,
   never rename).
3. Add a test in `tests/schema-lint.test.ts` that feeds a synthetic
   `ToolSummary` crafted to trip **only** the new rule, and asserts
   the returned `code` and `severity`. Update the `ALLOWED` array
   in the "every emitted finding has a code from the 12-rule union"
   test so it covers the new code.
4. Document the new rule in README.md's lint-rules table under
   `### \`probe_lint\``.
5. Add the new code to `scripts/smoke-lint.mjs`'s `REQUIRED_CODES`
   array — that script asserts every emitted finding's code is a
   member, so a missing entry makes the smoke test fail — and bump its
   "N-rule set" comments.
6. Keep the docs consistent: add the code to the lint-rules list in
   `docs/requirements/*-mcprobe-spec.md` (§6) and update the rule-count
   references in `docs/plans/*.md`.

## Adding a new fuzz case category

1. Open `src/fuzz.ts`. The `generateCases(schema)` function returns
   `FuzzCase[]` with one valid and at least three malformed variants.
2. Append a new `label` and `args` shape to the generator. Mark the
   new case `{ malformed: true }` so the runner can flag
   silently-accepted outcomes. The label must **not** be `"valid"` —
   the scorer partitions cases by `case === "valid"` (valid → Liveness,
   everything else → Error Handling), so a malformed case needs a
   distinct label.
3. Add a unit test in `tests/fuzz.test.ts` that exercises the new
   case shape against a synthetic primitive schema.
4. Document the new case label in README.md's "`probe_fuzz`" section.

## Fuzzing and scoring

- **Dry-run default.** `runFuzz` (src/fuzz.ts) skips tools annotated
  `destructiveHint: true` unless `fuzzDestructive` is set, and applies the
  `maxTools` cap to the remaining eligible tools. It returns
  `{ results, coverage }`; `coverage` (totalTools / fuzzedTools /
  skippedDestructive / skippedOverCap) is threaded into the report and
  rendered as the header **Coverage** line. The header also carries a
  **critical-issues callout** (`renderCriticalLine` in src/report.ts) —
  a flag listing silent-accepting tools + crash count, *not* a second
  score; the normalized scores are untouched.
- **Normalized, non-overlapping scoring** (src/conformance.ts). The two
  behavioral dimensions are rate-based so scores compare across server
  sizes, and they **partition the fuzz cases by kind** — malformed cases
  score Error Handling (`graceful / malformed`), valid cases score
  Liveness (`ok / valid`). Never score a case in both dimensions; that
  double-count was removed on purpose. `conformance.test.ts` pins both
  rates and the no-overlap guarantee.
- When fuzz is requested but no case ran (every tool skipped), the
  behavioral dimensions report **not measured** and drop out of the
  rollup — the same path as a static (`fuzz: false`) audit.

## Smoke and audit scripts

The `scripts/` directory contains two flavors of driver:

- **`scripts/smoke-*.mjs`** — five minimal end-to-end smoke checks
  that spawn the probe and the demo target, call one of the
  `probe_*` tools, and assert the response shape. They are the
  fastest signal that a code change has not broken a tool.
- **`scripts/self-audit.mjs` and `scripts/external-audit.mjs`** —
  full audit drivers that produce the Markdown reports saved under
  `examples/transcripts/`. `self-audit.mjs` launches a second copy
  of the probe as the target; `external-audit.mjs` spawns
  `@modelcontextprotocol/server-filesystem@latest` via `npx`.

Each script writes its Markdown output to `examples/transcripts/`
and prints a one-line summary to stderr. None of them write to
stdout.

## Connection registry

The probe can hold multiple live connections at once. The
`ConnectionRegistry` (in `src/target-client.ts`) is the single source
of truth:

- The most recently added connection becomes the default; the
  four core tools accept an optional `connectionId` and fall back to
  the default.
- `probe_disconnect` (the optional helper) closes one connection by
  id, or every connection if id is omitted. Closing the default
  promotes any other live connection to default.
- A new connection is added by `probe_connect` (which calls
  `connectStdio` or `connectHttp` underneath) and removed by
  `probe_disconnect`.
- Tests can substitute the registry via `setRegistryForTest(...)`
  to isolate state between cases.

## HTTP transport note

If the resolved `@modelcontextprotocol/sdk` version exposes
`StreamableHTTPClientTransport`, use it. Otherwise fall back to
`SSEClientTransport`. Document the choice in a short comment in
`src/target-client.ts` so future agents know which transport was
wired. The probe does not expose an HTTP endpoint of its own — it is
a stdio MCP server, period.
