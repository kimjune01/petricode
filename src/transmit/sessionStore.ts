import { Database } from "bun:sqlite";
import type { Turn, PerceivedEvent, Session, Content, ToolCall } from "../core/types.js";
import { createHash } from "crypto";
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";

const BLOB_THRESHOLD = 64 * 1024; // 64 KB

// Tolerate corrupted JSON cells. SQLite rows can come back with
// invalid JSON if a previous run crashed mid-write or the user edited
// the DB by hand. A single bad row used to throw straight out of
// read/list/readFull (uncaught), permanently bricking session resume
// and `/sessions`. Returning the supplied fallback (and warning to
// stderr so users know why a turn looks empty) lets the rest of the
// session load and degrades gracefully — the corrupted turn is just
// blank instead of taking everything else down with it.
function safeParseJson<T>(raw: string, fallback: T, ctx: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`sessionStore: skipping corrupted JSON (${ctx}): ${msg}`);
    return fallback;
  }
}

export class SessionStore {
  private db: Database;
  private blobDir: string;

  constructor(db: Database, dataDir: string) {
    this.db = db;
    this.blobDir = join(dataDir, "blobs");
    if (!existsSync(this.blobDir)) {
      mkdirSync(this.blobDir, { recursive: true });
    }
  }

  private ensureSession(sessionId: string): void {
    // Atomic upsert — avoids race condition on concurrent appends
    this.db.run(
      "INSERT OR IGNORE INTO sessions (id, created_at, metadata_json) VALUES (?, ?, ?)",
      [sessionId, Date.now(), "{}"]
    );
  }

  private storeBlob(data: string): string {
    const hash = createHash("sha256").update(data).digest("hex");
    const path = join(this.blobDir, hash);
    if (!existsSync(path)) {
      writeFileSync(path, data);
    }
    return hash;
  }

  private readBlob(hash: string): string {
    const path = join(this.blobDir, hash);
    return readFileSync(path, "utf-8");
  }

  private static readonly BLOB_PREFIX = "petricode_blob:";

  private externalizeContent(content: Content[]): Content[] {
    return content.map((c) => {
      if (c.type === "tool_result" && c.content.length > BLOB_THRESHOLD) {
        const hash = this.storeBlob(c.content);
        return { ...c, content: `${SessionStore.BLOB_PREFIX}${hash}` };
      }
      return c;
    });
  }

  private resolveResult(stored: string): string {
    if (!stored.startsWith(SessionStore.BLOB_PREFIX)) return stored;
    const hash = stored.slice(SessionStore.BLOB_PREFIX.length);
    try {
      return this.readBlob(hash);
    } catch {
      return `[blob missing: ${hash}]`;
    }
  }

  private internalizeContent(content: Content[]): Content[] {
    return content.map((c) => {
      if (c.type === "tool_result" && c.content.startsWith(SessionStore.BLOB_PREFIX)) {
        const hash = c.content.slice(SessionStore.BLOB_PREFIX.length);
        try {
          return { ...c, content: this.readBlob(hash) };
        } catch {
          // One missing blob (manual cleanup, partial restore, fs corruption)
          // shouldn't poison the entire session resume.
          return { ...c, content: `[blob missing: ${hash}]` };
        }
      }
      return c;
    });
  }

  append(event: PerceivedEvent): void {
    const sessionId = event.source;
    this.ensureSession(sessionId);

    const messageId = crypto.randomUUID();
    const storedContent = this.externalizeContent(event.content);

    this.db.run(
      "INSERT INTO messages (id, session_id, role, content_json, timestamp) VALUES (?, ?, ?, ?, ?)",
      [messageId, sessionId, event.role ?? "user", JSON.stringify(storedContent), event.timestamp]
    );
  }

  appendTurn(sessionId: string, turn: Turn): void {
    this.ensureSession(sessionId);

    const storedContent = this.externalizeContent(turn.content);

    this.db.run(
      "INSERT INTO messages (id, session_id, role, content_json, timestamp) VALUES (?, ?, ?, ?, ?)",
      [turn.id, sessionId, turn.role, JSON.stringify(storedContent), turn.timestamp]
    );

    if (turn.tool_calls) {
      for (const tc of turn.tool_calls) {
        let result = tc.result ?? null;
        if (result && result.length > BLOB_THRESHOLD) {
          const hash = this.storeBlob(result);
          result = `${SessionStore.BLOB_PREFIX}${hash}`;
        }
        this.db.run(
          "INSERT INTO tool_calls (message_id, tool_use_id, name, args_json, result) VALUES (?, ?, ?, ?, ?)",
          [turn.id, tc.id, tc.name, JSON.stringify(tc.args), result]
        );
      }
    }
  }

  read(sessionId: string): PerceivedEvent[] {
    const rows = this.db
      .query("SELECT role, content_json, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp, rowid")
      .all(sessionId) as { role: string; content_json: string; timestamp: number }[];

    return rows.map((row) => ({
      kind: "perceived" as const,
      source: sessionId,
      content: this.internalizeContent(
        safeParseJson<Content[]>(row.content_json, [], `messages.content_json sid=${sessionId}`),
      ),
      timestamp: row.timestamp,
      role: row.role as "user" | "assistant" | "system",
    }));
  }

  list(filter?: Record<string, unknown>): Session[] {
    let query = "SELECT s.id, s.created_at, s.metadata_json FROM sessions s";
    const params: (string | number)[] = [];

    if (filter?.limit) {
      query += " ORDER BY s.created_at DESC LIMIT ?";
      params.push(filter.limit as number);
    } else {
      query += " ORDER BY s.created_at DESC";
    }

    const sessions = this.db.query(query).all(...params) as {
      id: string;
      created_at: number;
      metadata_json: string;
    }[];

    return sessions.map((s) => ({
      id: s.id,
      turns: [],
      metadata: {
        ...safeParseJson<Record<string, unknown>>(s.metadata_json, {}, `sessions.metadata_json sid=${s.id}`),
        created_at: s.created_at,
      },
    }));
  }

  readFull(sessionId: string): Session | null {
    const sessionRow = this.db
      .query("SELECT id, created_at, metadata_json FROM sessions WHERE id = ?")
      .get(sessionId) as { id: string; created_at: number; metadata_json: string } | null;

    if (!sessionRow) return null;

    const messageRows = this.db
      .query("SELECT id, role, content_json, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp, rowid")
      .all(sessionId) as { id: string; role: string; content_json: string; timestamp: number }[];

    const turns: Turn[] = messageRows.map((m) => {
      const toolCallRows = this.db
        .query("SELECT tool_use_id, name, args_json, result FROM tool_calls WHERE message_id = ?")
        .all(m.id) as { tool_use_id: string | null; name: string; args_json: string; result: string | null }[];

      const toolCalls: ToolCall[] | undefined =
        toolCallRows.length > 0
          ? toolCallRows.map((tc) => ({
              id: tc.tool_use_id ?? crypto.randomUUID(),
              name: tc.name,
              args: safeParseJson<Record<string, unknown>>(
                tc.args_json,
                {},
                `tool_calls.args_json mid=${m.id} name=${tc.name}`,
              ),
              ...(tc.result != null
                ? { result: this.resolveResult(tc.result) }
                : {}),
            }))
          : undefined;

      return {
        id: m.id,
        role: m.role as Turn["role"],
        content: this.internalizeContent(
          safeParseJson<Content[]>(m.content_json, [], `messages.content_json mid=${m.id}`),
        ),
        timestamp: m.timestamp,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      };
    });

    return {
      id: sessionRow.id,
      turns,
      metadata: {
        ...safeParseJson<Record<string, unknown>>(
          sessionRow.metadata_json,
          {},
          `sessions.metadata_json sid=${sessionRow.id}`,
        ),
        created_at: sessionRow.created_at,
      },
    };
  }
}
