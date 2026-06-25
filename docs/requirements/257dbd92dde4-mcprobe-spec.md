# MCProbe — build spec

> Hand this file to CyOps as the project goal. It is self-contained: an agent can build the whole app from this document alone. It describes the **cleanest, simplest version** of the app — four core tools that map one-to-one to four pipeline stages.

---

## 1. One-line summary

MCProbe **calls your MCP server's tools with deliberately broken inputs and watches what breaks** — then lints its schemas and scores the whole thing 0–100. It is a **live, black-box conformance tester for MCP servers**: point it at any running server (local or remote, source or no source) and it audits the server the same way a real AI agent will hit it.

The headline capability is **behavioral fuzzing** — actually invoking tools and observing runtime behavior. Static linters can tell you a schema is valid; only MCProbe can tell you a tool *silently accepts garbage* or *crashes the session* on bad input.

---

## 2. Why it exists (and why it is not "just a linter")

An MCP server is an API whose primary consumer is a language model, not a human. The failures that matter are **runtime** failures an agent triggers, and they are invisible to static analysis:

| Failure mode | Why it breaks an agent | Only catchable by… |
| --- | --- | --- |
| Tool silently accepts garbage | Errors surface later as confusing results, not clear rejections | **calling the tool** (fuzz) |
| Tool crashes the connection on bad input | One bad call kills the whole session | **calling the tool** (fuzz) |
| Tool has no description | The model can't tell when to call it | lint |
| Parameter has no type | The model passes the wrong shape | lint |
| Parameter has no description | The model fills it with plausible-but-wrong values | lint |
| `required` list is empty | The model omits mandatory arguments | lint |

**Positioning:** MCProbe is a *behavioral* tester first and a linter second. It connects to a server as a **black box over the live protocol** — it never needs the server's source code, so it works on third-party, closed-source, and remote SSE servers, not just code you have on disk.

---

## 3. Tech stack (keep it minimal)

- **Language:** TypeScript, ESM, Node 18+.
- **MCP:** `@modelcontextprotocol/sdk` (latest). Use `McpServer` for the probe; use `Client` to talk to targets.
- **Validation:** `ajv` + `ajv-formats` for JSON-Schema validity checks.
- **Schemas:** `zod` for the probe's own tool inputs.
- **Tests:** `vitest`.
- **Build:** `tsc` only. No bundler. Output to `dist/`, ship a `bin` for `npx`.
- **No other runtime dependencies.** The fuzzer is hand-written and deterministic — do not pull a fuzzing/faker library.

---

## 4. The tools (this is the whole API)

The probe is a stdio MCP server exposing these tools. The **four core tools are the four pipeline stages**; the last two are optional convenience helpers.

### Core

1. **`probe_connect`** — open a connection to a target.
   - Inputs: `transport` (`"stdio"` | `"http"`), and either `command` + optional `args` + optional `env` (stdio), or `url` (http).
   - Behavior: connect as an MCP client, run the initialize handshake, count tools/resources/prompts.
   - Returns: a short `connectionId` plus server name, version, capabilities, and counts. Other tools default to the most recent connection.

2. **`probe_lint`** — static schema audit (read-only, calls nothing).
   - Lints every tool: JSON-Schema validity (Ajv compile) + agent-usability rules (see §6).
   - Returns: a list of findings, each with severity (`error`/`warning`/`info`), a stable code, a message, the location, and a concrete fix hint.

3. **`probe_fuzz`** — behavioral audit, the headline feature (⚠️ actually calls the target's tools).
   - For each tool, generate one valid input and several malformed ones (missing required field, wrong type, out-of-enum) from the schema, then call the tool.
   - Record per case: ok / tool-error (graceful) / protocol-crash, plus whether a malformed input was **silently accepted**, and latency in ms.
   - **Dry-run safety:** by default, skip tools annotated `destructiveHint: true` (opt in with `fuzzDestructive: true`). Apply the `maxTools` cap (default 10) to the remaining eligible tools.
   - Return a **coverage** summary: total tools, tools fuzzed, tools skipped as destructive, tools skipped over the cap.

4. **`probe_report`** — full audit + score.
   - Runs introspect + lint, and (if `fuzz: true`) fuzz, then produces a scored report (see §7).
   - Returns Markdown: overall score, per-dimension breakdown with reasons, findings, and fuzz table.

### Optional helpers (build only if time allows)

5. **`probe_list`** — enumerate the target's tools with descriptions and parameters.
6. **`probe_disconnect`** — close a connection (or all). Omit id to close all.

---

## 5. Architecture

```
host (Claude / IDE / agent)
        │  calls probe_* tools
        ▼
┌─────────────────────────────┐
│  MCProbe  (MCP server)    │
│                             │
│  index.ts      registers tools, routes calls
│  target-client.ts  outbound MCP client: connect / list / call / disconnect
│  schema-lint.ts    Ajv validity + usability rules → findings
│  fuzz.ts           JSON-Schema → valid & invalid test cases
│  conformance.ts    orchestrate lint+fuzz, compute scores
│  report.ts         pure renderers → Markdown
│  types.ts          shared types
└─────────────────────────────┘
        │  speaks MCP (as a client)
        ▼
   target MCP server  (the thing being audited — local or remote, no source needed)
```

**Core design idea:** MCProbe is a server and a client at the same time. It is a *server* to the host, and a *client* to the target. Keep those two roles in separate modules (`index.ts` vs `target-client.ts`). Everything else (lint, fuzz, score, render) is pure logic with no I/O, which makes it trivial to test.

**Data flow:** host → `index.ts` → audit modules → `target-client.ts` calls the target → results → `report.ts` → Markdown back to host.

---

## 6. Lint rules (the agent-usability checks)

Each produces a finding with a stable code:

- `tool.missing_description` (error) — tool has no description.
- `tool.thin_description` (warning) — description under ~12 chars.
- `tool.duplicate_name` (error) — same tool name twice.
- `tool.unusual_name` (warning) — name isn't snake_case/kebab-case.
- `tool.no_input_schema` (warning) — no input schema published.
- `schema.invalid` (error) — Ajv cannot compile the schema.
- `schema.root_not_object` (warning) — input schema isn't an object.
- `schema.no_required` (info) — has params but none marked required.
- `param.untyped` (warning) — parameter has no `type`/`enum`/`oneOf`.
- `param.missing_description` (warning) — parameter has no description.
- `tool.no_annotations` (info) — tool declares no MCP annotations (`readOnlyHint`, `destructiveHint`, etc.).
- `server.no_tools` (warning) — advertises tools capability but exposes none.

---

## 7. Scoring model

Four dimensions, each scored out of 10, rolled into an overall 0–100. The two **static** dimensions are subtractive (start at full marks, lose points per finding). The two **behavioral** dimensions are **normalized rates** so scores compare across servers of different sizes, and they partition the fuzz cases by kind so no outcome is counted twice. Reasons are listed in the report.

| Dimension | Measures |
| --- | --- |
| Metadata & Documentation | Server reported a name, version, and `instructions`? |
| Schema Quality | Count + severity of lint findings across tools. |
| Error Handling | Rate over **malformed** cases: `10 × (gracefully rejected / total malformed)`. Silent accepts and protocol crashes both count as failed rejections. Behavioral — only measured when fuzz runs. |
| Liveness & Performance | Rate over **valid** cases: `10 × (successful / total valid)`, minus a latency penalty (0.5 per 100ms over a 200ms p50 target). Behavioral — only measured when fuzz runs. |

**Measured-only scoring:** the overall score is the average of the dimensions actually evaluated. A static audit (no fuzz) is graded purely on Metadata + Schema Quality; the two behavioral dimensions are reported as "not measured" and excluded from the total rather than penalized with a fake value. (This is what lets a clean server — including MCProbe auditing itself — score 100/100 on a static audit.)

**Report header (when fuzz ran):** in addition to the score and grade, the header carries a **Coverage** line (tools fuzzed vs skipped) and a **critical-issues callout** — a flag, not a second score, summarizing silent-accepting tools and protocol crashes so the dangerous findings sit above the fold (`⚠ Critical: …`, or `✓ No critical behavioral issues`).

Grades: **A** ≥90, **B** ≥75, **C** ≥60, **D** ≥40, **F** <40.

---

## 8. Error-handling principles

- Every tool handler wraps its body in try/catch and returns a clean MCP error result (`isError: true`) with a readable message — never throws out of the handler.
- Guard against missing capabilities: a target that omits resources/prompts must not cause "method not found" to bubble up.
- Log only to **stderr** (stdout carries the JSON-RPC stream).
- Always inherit the parent env for stdio children so `PATH` resolves, then layer caller-supplied `env` on top.

---

## 9. Demo + dogfooding assets (build these too)

**(a) A deliberately-flawed target**, `flaky-demo-server`, under `examples/demo-target/`, with four tools so the probe always finds something:

- `greet` — no description, untyped parameter.
- `divide` — no type guard; silently returns NaN on bad input (models a tool that *silently accepts garbage*).
- `set_mode` — enum parameter with no description, thin tool description.
- `well_behaved` — the control: fully documented and validates its input, returning a graceful error on bad input.

**(b) A smoke / dogfood script** that connects the probe to this demo and prints connect → lint → report. Expected result: the flawed tools are flagged, `divide`/`greet` show as *silently accepted*, `well_behaved` correctly rejects bad input, overall grade C (low 70s).

**(c) Self-audit (dogfooding):** MCProbe must be able to probe **itself** (launch a second instance of `dist/index.js` as the target) and score itself an **A**. This is both a test and a demo talking point: "an MCP server that audits MCP servers — including itself."

---

## 10. Acceptance criteria (CyOps should verify each)

1. `npm install && npm run build` completes with no TypeScript errors.
2. `dist/index.js` starts a stdio MCP server that lists the four core tools.
3. `probe_connect` connects to the bundled demo over stdio and returns its name/version/counts.
4. `probe_lint` reports at least: one `tool.missing_description` and one `param.untyped` finding for the demo.
5. `probe_fuzz` shows `well_behaved` returning a tool error on bad input, and at least one flawed tool **silently accepting** bad input.
6. `probe_report` with `fuzz: true` prints an overall score, four per-dimension scores with reasons, and a fuzz table.
7. **Generality proof:** the probe successfully connects to and scores at least one **external, third-party MCP server** (e.g. `npx -y @modelcontextprotocol/server-everything` or `@modelcontextprotocol/server-filesystem /tmp`) — not just the bundled demo. Capture the report in the README or an `examples/` transcript.
8. **Self-audit:** MCProbe probes itself and scores an A (≥90).
9. **Tests:** a `vitest` suite covers the lint rules, the fuzz-case generator, and the demo fixtures; `npm test` passes.
10. A `README.md` leads with the **behavioral-testing** pitch (not "health check") and covers: problem, install, the tools, the scoring model, the 30-second demo, the external-server example, architecture, and limitations.
11. A `claude.md` agent-standards file documents conventions for agents working in the repo.
12. The only runtime dependencies are `@modelcontextprotocol/sdk`, `ajv`, `ajv-formats`, `zod` (`vitest` is dev-only).

---

## 11. Positioning guardrails (so it never reads as derivative)

MCProbe audits **MCP servers over the live protocol**. Keep the framing straight so it never reads as a clone of a repo-auditing tool:

- **Lead with behavior.** The first sentence everywhere is "it calls your tools with broken inputs and watches what breaks." Fuzzing is the hero; linting is the supporting act.
- **Black-box is the moat.** Emphasize that it needs no source code and works on remote/third-party servers. That is the thing static analyzers structurally cannot do.
- **Recursive framing is unique.** "An MCP server that is also an MCP client — it can probe other servers and itself." Use it.

### Terminology (use these terms in code, docs, tool names, and output)

The project uses a single canonical vocabulary so it stays visibly distinct from adjacent repo-auditing tools:

- **`conformance`**, **`audit`**, **`grade`** — the project's headline words.
- **`quality`**, **`schema quality`** — how well-formed a tool's schema is.
- **`report`**, **`findings`** — the output of an audit.
- **0–100 score** and **A–F grade** — the numeric and letter rollups.
- **`transport`** (stdio or http) — how a target is reached.
- **`severity`** (`error` / `warning` / `info`) — per-finding classification.
- **`probe_*`** prefix for tool names — the four core tools plus the two optional helpers.

**Always fine:** MCP, tool, schema, JSON Schema, conformance, fuzz, lint, transport, stdio, capability, severity, finding.

---

## 12. Keep-it-simple guardrails (avoid these to prevent tech debt)

Build the version above and **stop**. Do not add, in this first build:

- **No extra runtime dependencies** beyond the four listed.
- **No persistence / database** — connections live in memory for the session only.
- **No web UI or HTTP server for the probe itself** — it's stdio only. (HTTP is only a *target* transport.)
- **No auth flows** beyond passing `env` to stdio children and a plain URL for HTTP targets.
- **No deep schema generation** — best-effort sampling for nested/`oneOf` inputs is fine.
- **No resource/prompt linting yet** — count them, don't audit them.

---

## 13. Out of scope (roadmap, build later)

- `probe_fuzz` dry-run mode that skips destructive tools using `readOnlyHint`/`destructiveHint` annotations (makes it safe against real third-party servers by default).
- Lint and fuzz **resources** and **prompts**, not just tools.
- `probe_report --format json` for CI pipelines.
- A GitHub Action that runs the probe on every PR and comments the score.
