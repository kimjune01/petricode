# 05 — Remember

Persist to durable store. Remember is the CRUD interface to persistent storage. The store is the substrate; Remember is the API.

## Interface

```
Remember:
  .append(event: SessionEvent) → void
  .read(session_id: string) → Session | null
  .list(filter?: SessionFilter) → SessionSummary[]
  .prune(policy: PrunePolicy) → PruneResult { removed: number, freed_bytes: number }
  .write_skill(skill: Skill) → void
  .read_skills() → Skill[]
```

## Stores

### Session logs

Full conversation transcripts persisted to disk. Default implementation: SQLite database.

```
~/.config/petricode/data/<project-hash>/sessions.db
```

- **Schema:** sessions table (id, project_hash, start_time, last_updated, summary), messages table (session_id, role, content, timestamp, token_count), tool_calls table (session_id, message_id, name, args, result, status)
- **Write:** append on each message, tool call, and thought
- **Read:** on session resume, and by Consolidate for pattern extraction
- **Binary data:** MUST NOT store base64-encoded binary inline. Store a pointer to a separate file. Inline binary causes multi-GB databases and OOM on indexing.

### Filesystem (the primary store)

The agent reads and writes files as its primary Remember mechanism. The filesystem is shared with the human — the agent does not own it exclusively.

- **Write:** via tool execution (file write, shell commands)
- **Read:** via Perceive (context discovery, @-references, tool results)
- **Ownership:** the human owns the files. The agent is a guest.

### Procedural memory

Skills, instructions, and configuration that change how the agent processes future sessions.

```
~/.config/petricode/skills/       ← skills (procedures)
~/.config/petricode/memory/       ← learned facts, preferences
project/.agents/instructions      ← project-specific instructions
```

- **Write:** by Consolidate (skill extraction, memory distillation)
- **Read:** by Perceive (context discovery)
- **Contract:** Remember provides CRUD. Consolidate decides what to write.

### Decision records

Structured records of human decisions, persisted for Consolidate to read.

```
DecisionRecord:
  session_id: string
  turn_id: string
  decision_type: 'approve' | 'reject' | 'modify' | 'ignore'
  subject_ref: string              # what was decided on (tool call ID, plan ID, etc.)
  presented_context: string        # what the human saw at decision time
  problem_frame: string | null     # what problem was being solved
  outcome_ref: string | null       # what happened after the decision
  timestamp: string
```

```
Remember (extension):
  .append_decision(record: DecisionRecord) → void
  .list_decisions(filter?: DecisionFilter) → DecisionRecord[]
```

Without typed decision records, Consolidate's convergence detection has no structured input to work with.

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
