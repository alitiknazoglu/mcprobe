---
name: mcp-audit
description: >-
  Audit an MCP server for conformance — lint its tool schemas and behaviorally
  fuzz it (call tools with malformed input), then score it 0–100 (grade A–F)
  with the exact findings and fixes. Use when the user wants to check, test,
  validate, score, benchmark, or debug an MCP server, its tools or tool schemas,
  or figure out why an MCP server/tool behaves badly with an agent.
---

# Audit an MCP server (MCProbe)

MCProbe scores an MCP server's **conformance** — how reliably an AI agent can
actually use it — across schema quality and behavioral robustness. Reach for it
whenever the user wants to evaluate, test, compare, or debug an MCP server.

## Pick the path that's available

**A. MCProbe is connected as an MCP server (you have `probe_*` tools).**
Run the four core tools in order:
1. `probe_connect` — dial the target: an HTTPS URL, or a stdio command.
2. `probe_report` — the one-shot audit: lints the schemas, fuzzes behavior, and
   returns the full report + 0–100 score. (Use `probe_lint` / `probe_fuzz`
   individually if you want just one phase.)
3. `probe_disconnect` when finished.

**B. The `mcprobe` CLI is available (no MCP tools connected).**
```bash
# Remote HTTP(S) server
npx mcprobe audit https://example.com/mcp --fuzz

# Local stdio server (the `npx some-server` style)
npx mcprobe audit --stdio "npx @acme/my-mcp-server" --fuzz

# Machine-readable output (for scripting / CI gates)
npx mcprobe audit https://example.com/mcp --fuzz --json
```
Omit `--fuzz` for a fast static (schema-only) audit. Add `--json` to parse the
result programmatically.

## What `--fuzz` does — and the safety rule
Fuzzing **calls each tool with malformed input** to test error handling and
liveness. This is what catches the dangerous problems a linter can't: a tool
that *silently accepts* garbage (so the agent trusts a wrong result) or one that
*crashes the session*. It is **dry-run by default** — tools annotated
`destructiveHint: true` are skipped unless you pass `--fuzz-destructive`, so a
normal run is safe even on servers you don't own. **Only fuzz servers you're
allowed to test.**

## How to read the result
- **Overall 0–100 + grade A–F** (A ≥ 90, B ≥ 75, C ≥ 60, D ≥ 40, F < 40).
- **Four dimensions**, each 0–10: schema quality, error handling, liveness, and
  metadata/annotations.
- **Critical-issues callout:** tools that silently accept bad input, plus crash
  count — these hurt agents and users the most, so surface them first.
- **Findings** carry stable dotted codes (`tool.missing_description`,
  `param.untyped`, `schema.invalid`, …) and fix hints. Report the worst-severity
  ones with the exact tool/parameter and the recommended fix.

## Optional: save the run to a dashboard (needs an mcprobe.org Pro key)
```bash
npx mcprobe push https://example.com/mcp --fuzz --token "$MCPROBE_TOKEN"
```
`push` runs the same audit and uploads it to the user's mcprobe.org history and
public gallery. The audit itself is always free and local; only the hosted
upload is the Pro tier.

More detail (scoring model, the 12 lint rules, the fuzz categories):
https://github.com/alitiknazoglu/mcprobe
