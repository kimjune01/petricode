# 05 — Remember

Persist to durable store. Remember is the CRUD interface to persistent storage. The store is the substrate; Remember is the API.

## Stores

### Session logs

Full conversation transcripts persisted to disk.

```
~/.config/agent/tmp/<project-hash>/chats/session-<timestamp>-<id>.json
```

- **Format:** JSON with messages, tool calls, thoughts, token usage, timestamps
- **Write:** append on each message, tool call, and thought
- **Read:** on session resume
- **Binary data:** MUST NOT store base64-encoded binary inline. Store a pointer to a separate file. Inline binary causes multi-GB session files and OOM on indexing.

### Filesystem (the primary store)

The agent reads and writes files as its primary Remember mechanism. The filesystem is shared with the human — the agent does not own it exclusively.

- **Write:** via tool execution (file write, shell commands)
- **Read:** via Perceive (context discovery, @-references, tool results)
- **Ownership:** the human owns the files. The agent is a guest.

### Procedural memory

Skills, instructions, and configuration that change how the agent processes future sessions.

```
~/.config/agent/skills/       ← skills (procedures)
~/.config/agent/memory/       ← learned facts, preferences
project/.agent/instructions   ← project-specific instructions
```

- **Write:** by Consolidate (skill extraction, memory distillation)
- **Read:** by Perceive (context discovery)
- **Contract:** Remember provides CRUD. Consolidate decides what to write.

## Contract

- **Lossless:** Remember does not discard data. Lossy operations belong to Filter (eviction) or Cache (compaction).
- **Durable:** data survives process exit
- **CRUD:** create, read, update, delete — all four operations available
- **No eviction logic:** eviction is Filter's job (see 03-filter.md). Remember just stores.

## Anti-patterns

- Inline base64 binary in session logs (OOM)
- No separation between session data and procedural memory
- Write-only (no read path for Consolidate)
- Remember without Filter @ Remember (unbounded growth)
