# MCProbe self-audit

This transcript is the AC-8 **self-audit**: a second copy of `dist/index.js` was launched as the target, the host probe (also `dist/index.js`) ran `probe_report` against it over a real stdio MCP connection, and the result was saved here. The canonical score (gating exit 0) is the static-audit rollup.

**Target:** second copy of `/Users/probablynothing/Desktop/mcprobe/dist/index.js`
**Host probe:** first copy of `/Users/probablynothing/Desktop/mcprobe/dist/index.js`
**Target handshake:** `mcprobe` 0.1.0 (tools=6, resources=0, prompts=0)
**Target capabilities:** tools
**Audit timestamp (UTC):** 2026-11-08T07:50:50.498Z
**Static rollup (gating):** 95/100, grade **A**
**Behavioral rollup (informational):** 72/100, grade **C**

# MCProbe conformance report

**Server:** `mcprobe` 0.1.0
**Overall score:** 95 / 100
**Grade:** A

## Dimensions

### Metadata & Documentation: 10 / 10
- server reported name='mcprobe'
- server reported version='0.1.0'
- server advertised capabilities: tools

### Schema Quality: 8.96 / 10
- 5 finding(s) across 6 tool(s): 0 error, 0 warning, 5 info
- scored as a per-tool rate (0.21 deduction per tool), so breadth isn't penalized
-   schema.no_required: 5

### Error Handling: not measured
- not measured — pass \`fuzz: true\` to evaluate this dimension

### Liveness & Performance: not measured
- not measured — pass \`fuzz: true\` to evaluate this dimension

## Findings summary

5 finding(s): 0 error, 0 warning, 5 info

- **info** `schema.no_required` on `probe_disconnect` — Tool 'probe_disconnect' declares 1 parameter(s) but none are marked required.
- **info** `schema.no_required` on `probe_fuzz` — Tool 'probe_fuzz' declares 4 parameter(s) but none are marked required.
- **info** `schema.no_required` on `probe_lint` — Tool 'probe_lint' declares 1 parameter(s) but none are marked required.
- **info** `schema.no_required` on `probe_list` — Tool 'probe_list' declares 1 parameter(s) but none are marked required.
- **info** `schema.no_required` on `probe_report` — Tool 'probe_report' declares 5 parameter(s) but none are marked required.

## Fuzz table

No fuzz cases ran. Pass `fuzz: true` to evaluate Error Handling and Liveness.

## Recommended fixes

Address these to raise the score, worst first:

- **info** Add a top-level 'required' array listing the mandatory parameters so agents know which ones to populate. _(`schema.no_required`: probe_lint, probe_fuzz, probe_report, probe_list, probe_disconnect)_

---



## Appendix: behavioral audit (fuzz:true)



The canonical self-audit score above uses the spec's measured-only rollup (static dimensions only). For transparency, the same probe also ran with `fuzz: true`; that result follows. The behavioral score is informational only and is not required to be A — the AC-8 gate is the static score.



# MCProbe conformance report

**Server:** `mcprobe` 0.1.0
**Overall score:** 72 / 100
**Grade:** C
**Coverage:** fuzzed 2 of 6 tool(s); 1 skipped as destructive (probe_fuzz); 3 skipped as not annotated read-only/non-destructive (probe_connect, probe_report, probe_disconnect) — opt in with fuzzUnannotated / --fuzz-unannotated
**✓ No critical behavioral issues** — no silent accepts, hallucinated successes, output-schema violations or protocol crashes

## Dimensions

### Metadata & Documentation: 10 / 10
- server reported name='mcprobe'
- server reported version='0.1.0'
- server advertised capabilities: tools

### Schema Quality: 8.96 / 10
- 5 finding(s) across 6 tool(s): 0 error, 0 warning, 5 info
- scored as a per-tool rate (0.21 deduction per tool), so breadth isn't penalized
-   schema.no_required: 5

### Error Handling: 10 / 10
- 4/4 malformed input(s) rejected with a clean tool error (100%)
- every malformed input was rejected gracefully

### Liveness & Performance: 0 / 10
- 0/2 valid call(s) returned a real result (0%)
- 2 valid call(s) failed on good input (tool error or protocol crash)

## Findings summary

5 finding(s): 0 error, 0 warning, 5 info

- **info** `schema.no_required` on `probe_disconnect` — Tool 'probe_disconnect' declares 1 parameter(s) but none are marked required.
- **info** `schema.no_required` on `probe_fuzz` — Tool 'probe_fuzz' declares 4 parameter(s) but none are marked required.
- **info** `schema.no_required` on `probe_lint` — Tool 'probe_lint' declares 1 parameter(s) but none are marked required.
- **info** `schema.no_required` on `probe_list` — Tool 'probe_list' declares 1 parameter(s) but none are marked required.
- **info** `schema.no_required` on `probe_report` — Tool 'probe_report' declares 5 parameter(s) but none are marked required.

## Fuzz table

| Tool | Case | Outcome | Silent | Latency (ms) | Notes |
| --- | --- | --- | --- | --- | --- |
| `probe_lint` | `valid` | toolError | no | 2 | \[probe_lint\] connection 'mcprobe-connectionId' not found |
| `probe_lint` | `wrong_type:connectionId` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_lint` | `extra_garbage` | toolError | no | 0 | \[probe_lint\] connection 'mcprobe-connectionId' not found |
| `probe_list` | `valid` | toolError | no | 0 | \[probe_list\] connection 'mcprobe-connectionId' not found |
| `probe_list` | `wrong_type:connectionId` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_list` | `extra_garbage` | toolError | no | 0 | \[probe_list\] connection 'mcprobe-connectionId' not found |

## Recommended fixes

Address these to raise the score, worst first:

- **info** Add a top-level 'required' array listing the mandatory parameters so agents know which ones to populate. _(`schema.no_required`: probe_lint, probe_fuzz, probe_report, probe_list, probe_disconnect)_

---

*Self-audit script: `scripts/self-audit.mjs`*
*Audit timestamp (UTC): 2026-11-08T07:50:50.498Z*
