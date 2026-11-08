# Driving MCProbe from an AI agent

MCProbe is an MCP server, so an AI agent (Claude, Cursor, an autonomous
worker) drives it by calling its `probe_*` tools — no special client code
required. MCProbe also advertises server-level `instructions`, so on connect
the host is told the flow and the agent doesn't have to memorise tool names.

A typical audit is a three-call sequence:
`probe_connect` → `probe_report` → `probe_disconnect`.

---

## Example session

**User:** "Audit the MCP server at `node ./some-server.js` and tell me whether
it's safe to wire into my agent."

### 1. The agent opens a connection

`probe_connect`:

```json
{ "transport": "stdio", "command": "node", "args": ["./some-server.js"] }
```

(The probe only spawns this because its operator allowed that command line —
`MCPROBE_ALLOW_STDIO="node ./some-server.js"` in the probe's MCP config. See
[Security](../README.md#security).)

result:

```json
{
  "connectionId": "conn-1-ab12cd",
  "name": "some-server",
  "version": "1.0.0",
  "capabilities": { "tools": {} },
  "counts": { "tools": 4, "resources": 0, "prompts": 0 },
  "defaultConnectionId": "conn-1-ab12cd"
}
```

### 2. The agent runs a full report (with fuzzing)

`probe_report` — `fuzz: true` so the behavioral dimensions are scored by
actually calling the target's tools:

```json
{ "fuzz": true }
```

result (the `markdown` field of the structured `ConformanceReport`):

```markdown
# MCProbe conformance report

**Server:** `some-server` 1.0.0
**Overall score:** 73 / 100
**Grade:** C
**Coverage:** fuzzed 4 of 4 tool(s)
**⚠ Critical:** 3 tool(s) silently accept malformed input (greet, divide, set_mode)

## Dimensions
### Metadata & Documentation: 10 / 10
### Schema Quality: 3.5 / 10
- deducted for missing descriptions, untyped params, and no annotations
### Error Handling: 5.56 / 10
- 5/9 malformed input(s) rejected with a clean tool error (56%)
- 4 malformed case(s) silently accepted — the tool let bad input through
### Liveness & Performance: 10 / 10

## Findings summary
8 finding(s): 1 error, 3 warning, 4 info

## Fuzz table
| Tool | Case | Outcome | Silent | Latency (ms) | Notes |
| --- | --- | --- | --- | --- | --- |
| `divide` | wrong_type:a | ok | yes | 1 | |
...

## Recommended fixes
Address these to raise the score, worst first:

- **error** Add a one- or two-sentence description so language models can decide when to call it. _(`tool.missing_description`: greet)_
- **warning** Add a 'type' so agents know what values to pass. _(`param.untyped`: greet.name, divide.a, divide.b)_
- **info** Add MCP annotations so agents can reason about side effects. _(`tool.no_annotations`: greet, divide, set_mode)_
- **behavioral** Validate inputs and reject unknown keys so malformed arguments return a clear error instead of being silently accepted _(greet, divide, set_mode)_
```

### 3. The agent closes the connection

`probe_disconnect`:

```json
{}
```

### 4. The agent answers the user

> It scored **73/100 (C)**. The schemas have gaps (missing descriptions,
> untyped parameters, no annotations), and — more importantly — under fuzzing
> only about half its malformed inputs were rejected cleanly: several tools
> **silently accepted bad input** instead of returning an error (Error
> Handling 5.56/10). I'd hold off on wiring it into an autonomous workflow
> until those are fixed, since your agent could feed it bad arguments and get
> back plausible-looking garbage rather than a clear failure.

---

## Notes for agents

- **`fuzz: false`** runs a read-only static audit (metadata + schema quality
  only) — no calls to the target, safe against any server.
- **`fuzz: true`** really invokes the target's tools (a valid call plus
  malformed ones), so by default it **only fuzzes tools annotated
  `readOnlyHint: true` or `destructiveHint: false`** (the dry-run guard).
  Pass `fuzzUnannotated: true` to include tools with no safety annotations,
  `fuzzDestructive: true` to fuzz everything. The report
  includes a **coverage** summary of which tools were fuzzed vs skipped.
- Every tool returns both a human-readable text block **and** a structured
  payload (`structuredContent`), so an agent can either read the Markdown or
  pull the numbers out of `overall`, `grade`, `dimensions`, `coverage`, and
  `findings`.
- Omit `connectionId` to act on the most recently opened connection.
