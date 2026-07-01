# MCProbe self-audit

This transcript is the AC-8 **self-audit**: a second copy of `dist/index.js` was launched as the target, the host probe (also `dist/index.js`) ran `probe_report` against it over a real stdio MCP connection, and the result was saved here. The canonical score (gating exit 0) is the static-audit rollup.

**Target:** second copy of `/Users/probablynothing/Desktop/hackathon/mcprobe-work/dist/index.js`
**Host probe:** first copy of `/Users/probablynothing/Desktop/hackathon/mcprobe-work/dist/index.js`
**Target handshake:** `mcprobe` 0.1.0 (tools=6, resources=0, prompts=0)
**Target capabilities:** tools
**Audit timestamp (UTC):** 2026-07-01T16:43:19.895Z
**Static rollup (gating):** 94/100, grade **A**
**Behavioral rollup (informational):** 76/100, grade **B**

# MCProbe conformance report

**Server:** `mcprobe` 0.1.0
**Overall score:** 94 / 100
**Grade:** A

## Dimensions

### Metadata & Documentation: 10 / 10
- server reported name='mcprobe'
- server reported version='0.1.0'
- server advertised capabilities: tools

### Schema Quality: 8.75 / 10
- deducted 1.25 from 5 finding(s): 0 error, 0 warning, 5 info
-   schema.no_required: 5

### Error Handling: not measured
- not measured — pass `fuzz: true` to evaluate this dimension

### Liveness & Performance: not measured
- not measured — pass `fuzz: true` to evaluate this dimension

## Findings summary

5 finding(s): 0 error, 0 warning, 5 info

- **info** `schema.no_required` on `probe_disconnect` — Tool 'probe_disconnect' declares 1 parameter(s) but none are marked required.
- **info** `schema.no_required` on `probe_fuzz` — Tool 'probe_fuzz' declares 3 parameter(s) but none are marked required.
- **info** `schema.no_required` on `probe_lint` — Tool 'probe_lint' declares 1 parameter(s) but none are marked required.
- **info** `schema.no_required` on `probe_list` — Tool 'probe_list' declares 1 parameter(s) but none are marked required.
- **info** `schema.no_required` on `probe_report` — Tool 'probe_report' declares 4 parameter(s) but none are marked required.

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
**Overall score:** 76 / 100
**Grade:** B
**Coverage:** fuzzed 5 of 6 tool(s); 1 skipped as destructive (probe_fuzz)
**⚠ Critical:** 1 tool(s) silently accept malformed input (probe_disconnect)

## Dimensions

### Metadata & Documentation: 10 / 10
- server reported name='mcprobe'
- server reported version='0.1.0'
- server advertised capabilities: tools

### Schema Quality: 8.75 / 10
- deducted 1.25 from 5 finding(s): 0 error, 0 warning, 5 info
-   schema.no_required: 5

### Error Handling: 9.47 / 10
- 18/19 malformed input(s) rejected with a clean tool error (95%)
- 1 malformed case(s) silently accepted — the tool let bad input through

### Liveness & Performance: 2 / 10
- 1/5 valid call(s) succeeded (20%)
- 4 valid call(s) failed on good input (tool error or protocol crash)
- p50 latency on valid calls = 0ms (target 200ms)
- valid-call latency max = 0ms across 1 call(s)

## Findings summary

5 finding(s): 0 error, 0 warning, 5 info

- **info** `schema.no_required` on `probe_disconnect` — Tool 'probe_disconnect' declares 1 parameter(s) but none are marked required.
- **info** `schema.no_required` on `probe_fuzz` — Tool 'probe_fuzz' declares 3 parameter(s) but none are marked required.
- **info** `schema.no_required` on `probe_lint` — Tool 'probe_lint' declares 1 parameter(s) but none are marked required.
- **info** `schema.no_required` on `probe_list` — Tool 'probe_list' declares 1 parameter(s) but none are marked required.
- **info** `schema.no_required` on `probe_report` — Tool 'probe_report' declares 4 parameter(s) but none are marked required.

## Fuzz table

| Tool | Case | Outcome | Silent | Latency (ms) | Notes |
| --- | --- | --- | --- | --- | --- |
| `probe_connect` | `valid` | toolError | no | 2 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_connect` | `missing_required:transport` | toolError | no | 1 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_connect` | `wrong_type:transport` | toolError | no | 1 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_connect` | `wrong_type:command` | toolError | no | 1 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_connect` | `wrong_type:args` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_connect` | `wrong_type:env` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_connect` | `wrong_type:url` | toolError | no | 1 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_connect` | `out_of_enum:transport` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_connect` | `extra_garbage` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_lint` | `valid` | toolError | no | 0 | [probe_lint] connection 'mcprobe-connectionId' not found |
| `probe_lint` | `wrong_type:connectionId` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_lint` | `extra_garbage` | toolError | no | 0 | [probe_lint] connection 'mcprobe-connectionId' not found |
| `probe_report` | `valid` | toolError | no | 0 | [probe_report] connection 'mcprobe-connectionId' not found |
| `probe_report` | `wrong_type:connectionId` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_report` | `wrong_type:fuzz` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_report` | `wrong_type:maxTools` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_report` | `wrong_type:fuzzDestructive` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_report` | `extra_garbage` | toolError | no | 0 | [probe_report] connection 'mcprobe-connectionId' not found |
| `probe_list` | `valid` | toolError | no | 0 | [probe_list] connection 'mcprobe-connectionId' not found |
| `probe_list` | `wrong_type:connectionId` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_list` | `extra_garbage` | toolError | no | 0 | [probe_list] connection 'mcprobe-connectionId' not found |
| `probe_disconnect` | `valid` | ok | no | 0 |  |
| `probe_disconnect` | `wrong_type:id` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_disconnect` | `extra_garbage` | ok | yes | 0 |  |

## Recommended fixes

Address these to raise the score, worst first:

- **info** Add a top-level 'required' array listing the mandatory parameters so agents know which ones to populate. _(`schema.no_required`: probe_lint, probe_fuzz, probe_report, probe_list, probe_disconnect)_
- **behavioral** Validate inputs and reject unknown keys (e.g. a strict schema) so malformed arguments return a clear error instead of being silently accepted _(probe_disconnect)_

---

*Self-audit script: `scripts/self-audit.mjs`*
*Audit timestamp (UTC): 2026-07-01T16:43:19.895Z*
