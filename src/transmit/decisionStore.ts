import { Database } from "bun:sqlite";
import type { DecisionRecord } from "../core/types.js";

export class DecisionStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  write(sessionId: string, record: DecisionRecord): void {
    this.db.run(
      `INSERT INTO decisions (session_id, decision_type, subject_ref, presented_context_json, problem_frame, outcome_ref)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        sessionId,
        record.decision_type,
        record.subject_ref,
        JSON.stringify(record.presented_context),
        record.problem_frame,
        record.outcome_ref,
      ]
    );
  }

  list(filter?: Record<string, unknown>): DecisionRecord[] {
    let query = "SELECT decision_type, subject_ref, presented_context_json, problem_frame, outcome_ref FROM decisions";
    const params: (string | number)[] = [];

    if (filter?.session_id) {
      query += " WHERE session_id = ?";
      params.push(filter.session_id as string);
    }

    if (filter?.decision_type) {
      query += params.length > 0 ? " AND" : " WHERE";
      query += " decision_type = ?";
      params.push(filter.decision_type as string);
    }

    query += " ORDER BY id";

    const rows = this.db.query(query).all(...params) as {
      decision_type: string;
      subject_ref: string;
      presented_context_json: string;
      problem_frame: string;
      outcome_ref: string;
    }[];

    return rows.map((r) => ({
      decision_type: r.decision_type,
      subject_ref: r.subject_ref,
      presented_context: JSON.parse(r.presented_context_json),
      problem_frame: r.problem_frame,
      outcome_ref: r.outcome_ref,
    }));
  }
}
