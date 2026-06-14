# MCProbe self-audit

This transcript is the AC-8 **self-audit**: a second copy of `dist/index.js` was launched as the target, the host probe (also `dist/index.js`) ran `probe_report` against it over a real stdio MCP connection, and the result was saved here. The canonical score (gating exit 0) is the static-audit rollup.

**Target:** second copy of `/home/harness/cyops_data/workspace/mcprobe/dist/index.js`
**Host probe:** first copy of `/home/harness/cyops_data/workspace/mcprobe/dist/index.js`
**Target handshake:** `mcprobe` 0.1.0 (tools=6, resources=0, prompts=0)
**Target capabilities:** tools
**Audit timestamp (UTC):** 2026-06-14T11:35:22.637Z
**Static rollup (gating):** 94/100, grade **A**
**Behavioral rollup (informational):** 67/100, grade **C**

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
- **info** `schema.no_required` on `probe_fuzz` — Tool 'probe_fuzz' declares 2 parameter(s) but none are marked required.
- **info** `schema.no_required` on `probe_lint` — Tool 'probe_lint' declares 1 parameter(s) but none are marked required.
- **info** `schema.no_required` on `probe_list` — Tool 'probe_list' declares 1 parameter(s) but none are marked required.
- **info** `schema.no_required` on `probe_report` — Tool 'probe_report' declares 3 parameter(s) but none are marked required.

## Fuzz table

No fuzz cases ran. Pass `fuzz: true` to evaluate Error Handling and Liveness.

---



## Appendix: behavioral audit (fuzz:true)



The canonical self-audit score above uses the spec's measured-only rollup (static dimensions only). For transparency, the same probe also ran with `fuzz: true`; that result follows. The behavioral score is informational only and is not required to be A — the AC-8 gate is the static score.



# MCProbe conformance report

**Server:** `mcprobe` 0.1.0
**Overall score:** 67 / 100
**Grade:** C

## Dimensions

### Metadata & Documentation: 10 / 10
- server reported name='mcprobe'
- server reported version='0.1.0'
- server advertised capabilities: tools

### Schema Quality: 8.75 / 10
- deducted 1.25 from 5 finding(s): 0 error, 0 warning, 5 info
-   schema.no_required: 5

### Error Handling: 3 / 10
- 1 malformed case(s) were silently accepted (no tool error, no rejection)
- 5 valid case(s) returned a tool error (the tool is broken on good input)
- deducted 7 from 6 behavioral event(s) across 27 case(s)

### Liveness & Performance: 5 / 10
- p50 latency on valid calls = 1ms (target 200ms)
- valid-call latency max = 6ms across 1 call(s)
- 5 valid call(s) returned a tool error

## Findings summary

5 finding(s): 0 error, 0 warning, 5 info

- **info** `schema.no_required` on `probe_disconnect` — Tool 'probe_disconnect' declares 1 parameter(s) but none are marked required.
- **info** `schema.no_required` on `probe_fuzz` — Tool 'probe_fuzz' declares 2 parameter(s) but none are marked required.
- **info** `schema.no_required` on `probe_lint` — Tool 'probe_lint' declares 1 parameter(s) but none are marked required.
- **info** `schema.no_required` on `probe_list` — Tool 'probe_list' declares 1 parameter(s) but none are marked required.
- **info** `schema.no_required` on `probe_report` — Tool 'probe_report' declares 3 parameter(s) but none are marked required.

## Fuzz table

| Tool | Case | Outcome | Silent | Latency (ms) | Notes |
| --- | --- | --- | --- | --- | --- |
| `probe_connect` | `valid` | toolError | no | 6 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_connect` | `missing_required:transport` | toolError | no | 1 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_connect` | `wrong_type:transport` | toolError | no | 1 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_connect` | `wrong_type:command` | toolError | no | 1 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_connect` | `wrong_type:args` | toolError | no | 1 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_connect` | `wrong_type:env` | toolError | no | 1 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_connect` | `wrong_type:url` | toolError | no | 1 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_connect` | `out_of_enum:transport` | toolError | no | 1 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_connect` | `extra_garbage` | toolError | no | 1 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_lint` | `valid` | toolError | no | 1 | [probe_lint] connection 'mcprobe-connectionId' not found |
| `probe_lint` | `wrong_type:connectionId` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_lint` | `extra_garbage` | toolError | no | 0 | [probe_lint] connection 'mcprobe-connectionId' not found |
| `probe_fuzz` | `valid` | toolError | no | 1 | [probe_fuzz] connection 'mcprobe-connectionId' not found |
| `probe_fuzz` | `wrong_type:connectionId` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_fuzz` | `wrong_type:maxTools` | toolError | no | 1 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_fuzz` | `extra_garbage` | toolError | no | 0 | [probe_fuzz] connection 'mcprobe-connectionId' not found |
| `probe_report` | `valid` | toolError | no | 1 | [probe_report] connection 'mcprobe-connectionId' not found |
| `probe_report` | `wrong_type:connectionId` | toolError | no | 1 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_report` | `wrong_type:fuzz` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_report` | `wrong_type:maxTools` | toolError | no | 1 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_report` | `extra_garbage` | toolError | no | 0 | [probe_report] connection 'mcprobe-connectionId' not found |
| `probe_list` | `valid` | toolError | no | 0 | [probe_list] connection 'mcprobe-connectionId' not found |
| `probe_list` | `wrong_type:connectionId` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_list` | `extra_garbage` | toolError | no | 0 | [probe_list] connection 'mcprobe-connectionId' not found |
| `probe_disconnect` | `valid` | ok | no | 1 |  |
| `probe_disconnect` | `wrong_type:id` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `probe_disconnect` | `extra_garbage` | ok | yes | 0 |  |

---

*Self-audit script: `scripts/self-audit.mjs`*
*Audit timestamp (UTC): 2026-06-14T11:35:22.637Z*
