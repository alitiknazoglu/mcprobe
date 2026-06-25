# External MCP server audit — secure-filesystem-server

This transcript is the AC-7 **generality proof**: MCProbe (built from this repo) connected to a real, third-party MCP server fetched on the fly via `npx -y -p @modelcontextprotocol/server-filesystem@latest mcp-server-filesystem` and scored it 0–100 against the four conformance dimensions.

**Target package:** `@modelcontextprotocol/server-filesystem@latest`
**Target binary:** `mcp-server-filesystem`
**Allowed directory:** `/tmp/mcp-fs-allowed`
**Target version:** 0.2.0
**Audit timestamp (UTC):** 2026-06-25T17:58:49.048Z
**Target capabilities:** tools
**Tool count:** 14 tool(s), 0 resource(s), 0 prompt(s)

# MCProbe conformance report

**Server:** `secure-filesystem-server` 0.2.0
**Overall score:** 53 / 100
**Grade:** D
**Coverage:** fuzzed 10 of 14 tool(s); 2 skipped as destructive (write_file, edit_file); 2 skipped over the maxTools cap
**✓ No critical behavioral issues** — no silent accepts or protocol crashes

## Dimensions

### Metadata & Documentation: 10 / 10
- server reported name='secure-filesystem-server'
- server reported version='0.2.0'
- server advertised capabilities: tools

### Schema Quality: 1 / 10
- deducted 9.00 from 18 finding(s): 0 error, 18 warning, 0 info
-   param.missing_description: 18

### Error Handling: 10 / 10
- 42/42 malformed input(s) rejected with a clean tool error (100%)
- every malformed input was rejected gracefully

### Liveness & Performance: 0 / 10
- 0/10 valid call(s) succeeded (0%)
- 10 valid call(s) failed on good input (tool error or protocol crash)

## Findings summary

18 finding(s): 0 error, 18 warning, 0 info

- **warning** `param.missing_description` on `create_directory.path` — Parameter 'path' on tool 'create_directory' has no description.
- **warning** `param.missing_description` on `directory_tree.excludePatterns` — Parameter 'excludePatterns' on tool 'directory_tree' has no description.
- **warning** `param.missing_description` on `directory_tree.path` — Parameter 'path' on tool 'directory_tree' has no description.
- **warning** `param.missing_description` on `edit_file.edits` — Parameter 'edits' on tool 'edit_file' has no description.
- **warning** `param.missing_description` on `edit_file.path` — Parameter 'path' on tool 'edit_file' has no description.
- **warning** `param.missing_description` on `get_file_info.path` — Parameter 'path' on tool 'get_file_info' has no description.
- **warning** `param.missing_description` on `list_directory.path` — Parameter 'path' on tool 'list_directory' has no description.
- **warning** `param.missing_description` on `list_directory_with_sizes.path` — Parameter 'path' on tool 'list_directory_with_sizes' has no description.
- **warning** `param.missing_description` on `move_file.destination` — Parameter 'destination' on tool 'move_file' has no description.
- **warning** `param.missing_description` on `move_file.source` — Parameter 'source' on tool 'move_file' has no description.
- **warning** `param.missing_description` on `read_file.path` — Parameter 'path' on tool 'read_file' has no description.
- **warning** `param.missing_description` on `read_media_file.path` — Parameter 'path' on tool 'read_media_file' has no description.
- **warning** `param.missing_description` on `read_text_file.path` — Parameter 'path' on tool 'read_text_file' has no description.
- **warning** `param.missing_description` on `search_files.excludePatterns` — Parameter 'excludePatterns' on tool 'search_files' has no description.
- **warning** `param.missing_description` on `search_files.path` — Parameter 'path' on tool 'search_files' has no description.
- **warning** `param.missing_description` on `search_files.pattern` — Parameter 'pattern' on tool 'search_files' has no description.
- **warning** `param.missing_description` on `write_file.content` — Parameter 'content' on tool 'write_file' has no description.
- **warning** `param.missing_description` on `write_file.path` — Parameter 'path' on tool 'write_file' has no description.

## Fuzz table

| Tool | Case | Outcome | Silent | Latency (ms) | Notes |
| --- | --- | --- | --- | --- | --- |
| `read_file` | `valid` | toolError | no | 2 | Access denied - path outside allowed directories: /Users/pr… |
| `read_file` | `missing_required:path` | toolError | no | 1 | MCP error -32602: Input validation error: Invalid arguments… |
| `read_file` | `wrong_type:path` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `read_file` | `wrong_type:tail` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `read_file` | `wrong_type:head` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `read_file` | `extra_garbage` | toolError | no | 0 | Access denied - path outside allowed directories: /Users/pr… |
| `read_text_file` | `valid` | toolError | no | 0 | Access denied - path outside allowed directories: /Users/pr… |
| `read_text_file` | `missing_required:path` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `read_text_file` | `wrong_type:path` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `read_text_file` | `wrong_type:tail` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `read_text_file` | `wrong_type:head` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `read_text_file` | `extra_garbage` | toolError | no | 0 | Access denied - path outside allowed directories: /Users/pr… |
| `read_media_file` | `valid` | toolError | no | 0 | Access denied - path outside allowed directories: /Users/pr… |
| `read_media_file` | `missing_required:path` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `read_media_file` | `wrong_type:path` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `read_media_file` | `extra_garbage` | toolError | no | 0 | Access denied - path outside allowed directories: /Users/pr… |
| `read_multiple_files` | `valid` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `read_multiple_files` | `missing_required:paths` | toolError | no | 1 | MCP error -32602: Input validation error: Invalid arguments… |
| `read_multiple_files` | `wrong_type:paths` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `read_multiple_files` | `extra_garbage` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `create_directory` | `valid` | toolError | no | 0 | Access denied - path outside allowed directories: /Users/pr… |
| `create_directory` | `missing_required:path` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `create_directory` | `wrong_type:path` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `create_directory` | `extra_garbage` | toolError | no | 0 | Access denied - path outside allowed directories: /Users/pr… |
| `list_directory` | `valid` | toolError | no | 0 | Access denied - path outside allowed directories: /Users/pr… |
| `list_directory` | `missing_required:path` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `list_directory` | `wrong_type:path` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `list_directory` | `extra_garbage` | toolError | no | 0 | Access denied - path outside allowed directories: /Users/pr… |
| `list_directory_with_sizes` | `valid` | toolError | no | 0 | Access denied - path outside allowed directories: /Users/pr… |
| `list_directory_with_sizes` | `missing_required:path` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `list_directory_with_sizes` | `wrong_type:path` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `list_directory_with_sizes` | `wrong_type:sortBy` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `list_directory_with_sizes` | `out_of_enum:sortBy` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `list_directory_with_sizes` | `extra_garbage` | toolError | no | 0 | Access denied - path outside allowed directories: /Users/pr… |
| `directory_tree` | `valid` | toolError | no | 0 | Access denied - path outside allowed directories: /Users/pr… |
| `directory_tree` | `missing_required:path` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `directory_tree` | `wrong_type:path` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `directory_tree` | `wrong_type:excludePatterns` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `directory_tree` | `extra_garbage` | toolError | no | 0 | Access denied - path outside allowed directories: /Users/pr… |
| `move_file` | `valid` | toolError | no | 0 | Access denied - path outside allowed directories: /Users/pr… |
| `move_file` | `missing_required:source` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `move_file` | `missing_required:destination` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `move_file` | `wrong_type:source` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `move_file` | `wrong_type:destination` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `move_file` | `extra_garbage` | toolError | no | 0 | Access denied - path outside allowed directories: /Users/pr… |
| `search_files` | `valid` | toolError | no | 0 | Access denied - path outside allowed directories: /Users/pr… |
| `search_files` | `missing_required:path` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `search_files` | `missing_required:pattern` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `search_files` | `wrong_type:path` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `search_files` | `wrong_type:pattern` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `search_files` | `wrong_type:excludePatterns` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `search_files` | `extra_garbage` | toolError | no | 0 | Access denied - path outside allowed directories: /Users/pr… |

---

**Audit summary:** overall 53/100, grade **D**, 18 lint finding(s), 52 fuzz case(s).

**Per-dimension scores (out of 10):**

| Dimension | Score |
| --- | --- |
| Metadata & Documentation | 10 / 10 |
| Schema Quality | 1 / 10 |
| Error Handling | 10 / 10 |
| Liveness & Performance | 0 / 10 |

*Generated by MCProbe on 2026-06-25T17:58:49.048Z.*
