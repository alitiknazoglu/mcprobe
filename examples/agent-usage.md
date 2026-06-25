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
**Overall score:** 64 / 100
**Grade:** C

## Dimensions
### Metadata & Documentation: 10 / 10
### Schema Quality: 3.5 / 10
- deducted for missing descriptions, untyped params, and no annotations
### Error Handling: 2 / 10
- 3 malformed inputs were silently accepted (no isError) across the tools
### Liveness & Performance: 10 / 10

## Findings summary
8 finding(s): 1 error, 3 warning, 4 info

## Fuzz table
| Tool | Case | Outcome | Silent | Latency (ms) | Notes |
| --- | --- | --- | --- | --- | --- |
| `divide` | wrong_type:a | ok | yes | 1 | |
...
```

### 3. The agent closes the connection

`probe_disconnect`:

```json
{}
```

### 4. The agent answers the user

> It scored **64/100 (C)**. The schemas have gaps (missing descriptions,
> untyped parameters, no annotations), and — more importantly — under fuzzing
> several tools **silently accepted malformed input** instead of returning an
> error (Error Handling 2/10). I'd hold off on wiring it into an autonomous
> workflow until those are fixed, since your agent could feed it bad arguments
> and get back plausible-looking garbage rather than a clear failure.

---

## Notes for agents

- **`fuzz: false`** runs a read-only static audit (metadata + schema quality
  only) — no calls to the target, safe against any server.
- **`fuzz: true`** invokes the target's tools with malformed inputs; only fuzz
  servers you trust or that are read-only. MCProbe's own `probe_fuzz` /
  `probe_report` tools are annotated `openWorldHint: true` (and `probe_fuzz`
  `destructiveHint: true`) so a host can warn before running them.
- Every tool returns both a human-readable text block **and** a structured
  payload (`structuredContent`), so an agent can either read the Markdown or
  pull the numbers out of `overall`, `grade`, `dimensions`, and `findings`.
- Omit `connectionId` to act on the most recently opened connection.
