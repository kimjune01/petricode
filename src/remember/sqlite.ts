import { Database } from "bun:sqlite";
import { readFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import type { RememberSlot } from "../core/contracts.js";
import type { PerceivedEvent, Session, Skill, DecisionRecord } from "../core/types.js";
import { SessionStore } from "./sessionStore.js";
import { SkillStore } from "./skillStore.js";
import { DecisionStore } from "./decisionStore.js";

const SCHEMA_PATH = join(dirname(import.meta.path), "schema.sql");

export interface SqliteRememberOptions {
  dataDir: string;
  skillsDir?: string;
}

export function createSqliteRemember(opts: SqliteRememberOptions): RememberSlot {
  const { dataDir } = opts;
  const skillsDir = opts.skillsDir ?? join(dataDir, "..", "skills");

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = join(dataDir, "sessions.db");
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  const schema = readFileSync(SCHEMA_PATH, "utf-8");
  db.exec(schema);

  const sessionStore = new SessionStore(db, dataDir);
  const skillStore = new SkillStore(skillsDir);
  const decisionStore = new DecisionStore(db);

  return {
    async append(event: PerceivedEvent): Promise<void> {
      sessionStore.append(event);
    },

    async read(session_id: string): Promise<PerceivedEvent[]> {
      return sessionStore.read(session_id);
    },

    async list(filter?: Record<string, unknown>): Promise<Session[]> {
      return sessionStore.list(filter);
    },

    async write_skill(skill: Skill): Promise<void> {
      skillStore.write(skill);
    },

    read_skills: async (): Promise<Skill[]> => {
      return skillStore.readAll();
    },

    async delete_skill(name: string): Promise<boolean> {
      return skillStore.delete(name);
    },

    async list_decisions(filter?: Record<string, unknown>): Promise<DecisionRecord[]> {
      return decisionStore.list(filter);
    },

    // Expose for writing decisions (not in contract but needed internally)
    _writeDecision(sessionId: string, record: DecisionRecord): void {
      decisionStore.write(sessionId, record);
    },
  } as RememberSlot & { _writeDecision(sessionId: string, record: DecisionRecord): void };
}
