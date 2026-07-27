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

# A server that requires an API key
npx mcprobe audit https://api.acme.com/mcp --bearer "$ACME_TOKEN" --fuzz
npx mcprobe audit https://api.acme.com/mcp --header "X-API-Key: $ACME_KEY"

# Machine-readable output (for scripting / CI gates)
npx mcprobe audit https://example.com/mcp --fuzz --json
```
Omit `--fuzz` for a fast static (schema-only) audit. Add `--json` to parse the
result programmatically.

## Auditing a server that needs credentials
If a target answers `401`/`Unauthorized`, it needs a credential: pass it with
`--bearer <token>` (sends `Authorization: Bearer …`) or `--header "Name: Value"`
for anything else. `MCPROBE_TARGET_TOKEN` works instead of `--bearer`.

Three things to get right:
- **Never invent or guess a credential, and never reuse one the user hasn't
  offered for this purpose.** Ask the user for it, and prefer an environment
  variable over pasting the literal value into a command you echo back.
- **`--bearer` and `--token` are different keys.** `--bearer` authenticates to
  the *server being audited*; `--token` authenticates to *mcprobe.org* for
  `push`. Passing the MCProbe token as `--bearer` would hand it to a third party.
- **A stdio server takes credentials through its own environment**, not these
  flags — the CLI rejects them for `--stdio` targets.

Servers behind a full OAuth login flow can't be audited yet; say so plainly
rather than trying to synthesize a token.

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
- **Critical-issues callout:** the behaviors that hurt agents and users most, so
  surface them first — tools that **silently accept bad input**, tools that
  return an **empty success on a valid call** (a *hallucinated success*: the tool
  reports "done" but returns/persists nothing), tools that return a success that
  **violates their declared `outputSchema`** (the payload doesn't honor the
  contract the tool advertised), and **protocol crashes**.
- **Findings** carry stable dotted codes (`tool.missing_description`,
  `param.untyped`, `schema.invalid`, …) and fix hints. Report the worst-severity
  ones with the exact tool/parameter and the recommended fix.

## Optional: save the run to a dashboard (needs an mcprobe.org Pro key)

`push` runs the same audit and **uploads** it to the user's mcprobe.org history
and public gallery. The audit itself is always free and local; only the hosted
upload is the Pro tier.

**How the user gets a key (one-time):**
1. Go to **https://www.mcprobe.org** and **sign up** (email + password, then
   confirm via the email link).
2. **Go Pro** — $9.90 once, lifetime. Click "Go Pro" / "Unlock" and pay by
   **crypto** (card checkout is coming soon).
3. Open **My Profile** → https://www.mcprobe.org/app/profile.
4. In the **"Audit a local (stdio) server"** card, click **Generate key**. A
   token like `mcp_…` appears — it's shown **only once**, so copy it right away.
5. Store it as an environment variable (keeps it out of shell history / code):
   ```bash
   export MCPROBE_TOKEN="mcp_your_key_here"
   ```

Then upload any audit:
```bash
npx mcprobe push https://example.com/mcp --fuzz --token "$MCPROBE_TOKEN"
```
The CLI also reads `MCPROBE_TOKEN` from the environment, so `--token` can be
omitted once it's set.

More detail (scoring model, the 12 lint rules, the fuzz categories):
https://github.com/alitiknazoglu/mcprobe
