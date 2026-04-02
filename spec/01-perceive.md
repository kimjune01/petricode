# 01 — Perceive

Transform external signals into structured input the pipeline can process.

## Sources

| Source | Signal | Structured output |
|--------|--------|-------------------|
| Terminal | Raw keypresses, escape sequences | Logical key events (Key objects) |
| Piped stdin | Byte stream | UTF-8 text with size limit |
| Filesystem | File paths, directory trees | File contents with metadata |
| API response | Streaming chunks | Validated response parts |
| File references | `@path/to/file` in user input | Resolved file contents |
| Context files | GEMINI.md, .claude/, project instructions | Tiered instruction text |

## Contract

- **Input:** raw bytes, paths, or network streams
- **Output:** structured, typed, validated data
- **Timeout:** every Perceive operation has a bounded timeout. No unbounded waits.
- **Retry:** failed perception retries with backoff. Retry is re-perception, not a separate role.
- **Idempotency:** same input produces same structured output.

## Requirements

1. **Terminal input** must handle escape sequences, paste detection, and multi-byte characters.
2. **Piped input** must enforce a size limit (e.g., 8MB) and a timeout for non-TTY terminals that never send EOF.
3. **Filesystem reads** must resolve paths, handle symlinks, and respect trust boundaries.
4. **API retry** must use exponential backoff with jitter. Retry is model-version-agnostic — do not gate retry logic on model name prefixes.
5. **Context discovery** must scan hierarchically: global → project → subdirectory. Load eagerly at root, lazily at depth (see 02-cache.md for the tree structure).
6. **File reference expansion** (`@path`) must resolve before sending to inference. The model sees file contents, not path references.

## Anti-patterns

- Gating retry on model version strings (breaks when new models ship)
- Unbounded stdin reads (hangs on non-TTY terminals)
- Loading all context eagerly (see 08-anti-patterns.md)
