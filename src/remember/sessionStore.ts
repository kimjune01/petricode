import { Database } from "bun:sqlite";
import type { Turn, PerceivedEvent, Session, Content, ToolCall } from "../core/types.js";
import { createHash } from "crypto";
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";

const BLOB_THRESHOLD = 64 * 1024; // 64 KB

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

  private internalizeContent(content: Content[]): Content[] {
    return content.map((c) => {
      if (c.type === "tool_result" && c.content.startsWith(SessionStore.BLOB_PREFIX)) {
        const hash = c.content.slice(SessionStore.BLOB_PREFIX.length);
        return { ...c, content: this.readBlob(hash) };
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
      content: this.internalizeContent(JSON.parse(row.content_json)),
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
      metadata: { ...JSON.parse(s.metadata_json), created_at: s.created_at },
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
              args: JSON.parse(tc.args_json),
              ...(tc.result != null
                ? { result: tc.result.startsWith(SessionStore.BLOB_PREFIX) ? this.readBlob(tc.result.slice(SessionStore.BLOB_PREFIX.length)) : tc.result }
                : {}),
            }))
          : undefined;

      return {
        id: m.id,
        role: m.role as Turn["role"],
        content: this.internalizeContent(JSON.parse(m.content_json)),
        timestamp: m.timestamp,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      };
    });

    return {
      id: sessionRow.id,
      turns,
      metadata: { ...JSON.parse(sessionRow.metadata_json), created_at: sessionRow.created_at },
    };
  }
}
