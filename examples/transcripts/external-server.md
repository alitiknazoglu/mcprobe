# External MCP server audit — secure-filesystem-server

This transcript is the AC-7 **generality proof**: MCProbe (built from this repo) connected to a real, third-party MCP server fetched on the fly via `npx -y -p @modelcontextprotocol/server-filesystem@latest mcp-server-filesystem` and scored it 0–100 against the four conformance dimensions.

**Target package:** `@modelcontextprotocol/server-filesystem@latest`
**Target binary:** `mcp-server-filesystem`
**Allowed directory:** `/tmp/mcp-fs-allowed`
**Target version:** 0.2.0
**Audit timestamp (UTC):** 2026-06-14T11:25:39.611Z
**Target capabilities:** tools
**Tool count:** 14 tool(s), 0 resource(s), 0 prompt(s)

# MCProbe conformance report

**Server:** `secure-filesystem-server` 0.2.0
**Overall score:** 28 / 100
**Grade:** F

## Dimensions

### Metadata & Documentation: 10 / 10
- server reported name='secure-filesystem-server'
- server reported version='0.2.0'
- server advertised capabilities: tools

### Schema Quality: 1 / 10
- deducted 9.00 from 18 finding(s): 0 error, 18 warning, 0 info
-   param.missing_description: 18

### Error Handling: 0 / 10
- 10 valid case(s) returned a tool error (the tool is broken on good input)
- deducted 10 from 10 behavioral event(s) across 52 case(s)

### Liveness & Performance: 0 / 10
- no valid-call latencies were collected
- 10 valid call(s) returned a tool error

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
| `read_file` | `valid` | toolError | no | 7 | Access denied - path outside allowed directories: /home/har… |
| `read_file` | `missing_required:path` | toolError | no | 2 | MCP error -32602: Input validation error: Invalid arguments… |
| `read_file` | `wrong_type:path` | toolError | no | 1 | MCP error -32602: Input validation error: Invalid arguments… |
| `read_file` | `wrong_type:tail` | toolError | no | 1 | MCP error -32602: Input validation error: Invalid arguments… |
| `read_file` | `wrong_type:head` | toolError | no | 1 | MCP error -32602: Input validation error: Invalid arguments… |
| `read_file` | `extra_garbage` | toolError | no | 1 | Access denied - path outside allowed directories: /home/har… |
| `read_text_file` | `valid` | toolError | no | 1 | Access denied - path outside allowed directories: /home/har… |
| `read_text_file` | `missing_required:path` | toolError | no | 1 | MCP error -32602: Input validation error: Invalid arguments… |
| `read_text_file` | `wrong_type:path` | toolError | no | 1 | MCP error -32602: Input validation error: Invalid arguments… |
| `read_text_file` | `wrong_type:tail` | toolError | no | 1 | MCP error -32602: Input validation error: Invalid arguments… |
| `read_text_file` | `wrong_type:head` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `read_text_file` | `extra_garbage` | toolError | no | 0 | Access denied - path outside allowed directories: /home/har… |
| `read_media_file` | `valid` | toolError | no | 1 | Access denied - path outside allowed directories: /home/har… |
| `read_media_file` | `missing_required:path` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `read_media_file` | `wrong_type:path` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `read_media_file` | `extra_garbage` | toolError | no | 1 | Access denied - path outside allowed directories: /home/har… |
| `read_multiple_files` | `valid` | toolError | no | 1 | MCP error -32602: Input validation error: Invalid arguments… |
| `read_multiple_files` | `missing_required:paths` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `read_multiple_files` | `wrong_type:paths` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `read_multiple_files` | `extra_garbage` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `write_file` | `valid` | toolError | no | 1 | Access denied - path outside allowed directories: /home/har… |
| `write_file` | `missing_required:path` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `write_file` | `missing_required:content` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `write_file` | `wrong_type:path` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `write_file` | `wrong_type:content` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `write_file` | `extra_garbage` | toolError | no | 1 | Access denied - path outside allowed directories: /home/har… |
| `edit_file` | `valid` | toolError | no | 1 | Access denied - path outside allowed directories: /home/har… |
| `edit_file` | `missing_required:path` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `edit_file` | `missing_required:edits` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `edit_file` | `wrong_type:path` | toolError | no | 3 | MCP error -32602: Input validation error: Invalid arguments… |
| `edit_file` | `wrong_type:edits` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `edit_file` | `wrong_type:dryRun` | toolError | no | 1 | MCP error -32602: Input validation error: Invalid arguments… |
| `edit_file` | `extra_garbage` | toolError | no | 1 | Access denied - path outside allowed directories: /home/har… |
| `create_directory` | `valid` | toolError | no | 1 | Access denied - path outside allowed directories: /home/har… |
| `create_directory` | `missing_required:path` | toolError | no | 1 | MCP error -32602: Input validation error: Invalid arguments… |
| `create_directory` | `wrong_type:path` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `create_directory` | `extra_garbage` | toolError | no | 0 | Access denied - path outside allowed directories: /home/har… |
| `list_directory` | `valid` | toolError | no | 0 | Access denied - path outside allowed directories: /home/har… |
| `list_directory` | `missing_required:path` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `list_directory` | `wrong_type:path` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `list_directory` | `extra_garbage` | toolError | no | 0 | Access denied - path outside allowed directories: /home/har… |
| `list_directory_with_sizes` | `valid` | toolError | no | 1 | Access denied - path outside allowed directories: /home/har… |
| `list_directory_with_sizes` | `missing_required:path` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `list_directory_with_sizes` | `wrong_type:path` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `list_directory_with_sizes` | `wrong_type:sortBy` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `list_directory_with_sizes` | `out_of_enum:sortBy` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `list_directory_with_sizes` | `extra_garbage` | toolError | no | 1 | Access denied - path outside allowed directories: /home/har… |
| `directory_tree` | `valid` | toolError | no | 1 | Access denied - path outside allowed directories: /home/har… |
| `directory_tree` | `missing_required:path` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `directory_tree` | `wrong_type:path` | toolError | no | 0 | MCP error -32602: Input validation error: Invalid arguments… |
| `directory_tree` | `wrong_type:excludePatterns` | toolError | no | 1 | MCP error -32602: Input validation error: Invalid arguments… |
| `directory_tree` | `extra_garbage` | toolError | no | 1 | Access denied - path outside allowed directories: /home/har… |

---

**Audit summary:** overall 28/100, grade **F**, 18 lint finding(s), 52 fuzz case(s).

**Per-dimension scores (out of 10):**

| Dimension | Score |
| --- | --- |
| Metadata & Documentation | 10 / 10 |
| Schema Quality | 1 / 10 |
| Error Handling | 0 / 10 |
| Liveness & Performance | 0 / 10 |

*Generated by MCProbe on 2026-06-14T11:25:39.611Z.*
