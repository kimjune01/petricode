import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createSqliteTransmit } from "../src/transmit/sqlite.js";
import type { PerceivedEvent, Skill, DecisionRecord } from "../src/core/types.js";

let tmpDir: string;
let transmit: ReturnType<typeof createSqliteTransmit>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "petricode-test-"));
  transmit = createSqliteTransmit({
    dataDir: join(tmpDir, "data"),
    skillsDir: join(tmpDir, "skills"),
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SessionStore", () => {
  test("append two turns and read them back", async () => {
    const sessionId = "test-session-1";
    const event1: PerceivedEvent = {
      kind: "perceived",
      source: sessionId,
      content: [{ type: "text", text: "Hello world" }],
      timestamp: 1000,
    };
    const event2: PerceivedEvent = {
      kind: "perceived",
      source: sessionId,
      content: [{ type: "text", text: "Second message" }],
      timestamp: 2000,
    };

    await transmit.append(event1);
    await transmit.append(event2);

    const events = await transmit.read(sessionId);
    expect(events).toHaveLength(2);
    expect(events[0]!.content[0]).toEqual({ type: "text", text: "Hello world" });
    expect(events[1]!.content[0]).toEqual({ type: "text", text: "Second message" });
    expect(events[0]!.timestamp).toBe(1000);
    expect(events[1]!.timestamp).toBe(2000);
  });

  test("list sessions returns created session", async () => {
    const event: PerceivedEvent = {
      kind: "perceived",
      source: "session-abc",
      content: [{ type: "text", text: "test" }],
      timestamp: Date.now(),
    };

    await transmit.append(event);
    const sessions = await transmit.list();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions.some((s) => s.id === "session-abc")).toBe(true);
  });
});

describe("SkillStore", () => {
  test("write a skill, read it back", async () => {
    const skill: Skill = {
      name: "test-skill",
      body: "This is the skill body.\n\nIt has multiple paragraphs.",
      frontmatter: { description: "A test skill", version: 1 },
      trigger: "slash_command",
    };

    await transmit.write_skill!(skill);
    const skills = await transmit.read_skills!();

    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("test-skill");
    expect(skills[0]!.body).toBe(skill.body);
    expect(skills[0]!.frontmatter.description).toBe("A test skill");
    expect(skills[0]!.frontmatter.version).toBe(1);
    expect(skills[0]!.trigger).toBe("slash_command");
  });

  test("delete a skill returns true, subsequent read excludes it", async () => {
    const skill: Skill = {
      name: "to-delete",
      body: "temporary",
      frontmatter: {},
      trigger: "manual",
    };

    await transmit.write_skill!(skill);
    const deleted = await transmit.delete_skill!("to-delete");
    expect(deleted).toBe(true);

    const skills = await transmit.read_skills!();
    expect(skills.some((s) => s.name === "to-delete")).toBe(false);
  });

  test("delete nonexistent skill returns false", async () => {
    const deleted = await transmit.delete_skill!("nonexistent");
    expect(deleted).toBe(false);
  });
});

describe("DecisionStore", () => {
  test("write a decision record, list decisions", async () => {
    const sessionId = "decision-session";
    const event: PerceivedEvent = {
      kind: "perceived",
      source: sessionId,
      content: [{ type: "text", text: "context" }],
      timestamp: Date.now(),
    };
    await transmit.append(event);

    const record: DecisionRecord = {
      decision_type: "tool_selection",
      subject_ref: "grep-vs-find",
      presented_context: [
        { source: "user_prompt", content: "find files matching pattern", relevance: 0.9 },
      ],
      problem_frame: "User needs file search — grep searches content, find searches names",
      outcome_ref: "selected:grep",
    };

    await transmit.append_decision!(sessionId, record);

    const decisions = await transmit.list_decisions!();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.decision_type).toBe("tool_selection");
    expect(decisions[0]!.subject_ref).toBe("grep-vs-find");
    expect(decisions[0]!.presented_context).toHaveLength(1);
    expect(decisions[0]!.presented_context[0]!.relevance).toBe(0.9);
    expect(decisions[0]!.problem_frame).toBe(record.problem_frame);
    expect(decisions[0]!.outcome_ref).toBe("selected:grep");
  });
});

describe("Binary content", () => {
  test("large tool result stored as file pointer", async () => {
    const sessionId = "blob-session";
    const largeContent = "x".repeat(128 * 1024); // 128 KB

    const event: PerceivedEvent = {
      kind: "perceived",
      source: sessionId,
      content: [{ type: "tool_result", tool_use_id: "tu-1", content: largeContent }],
      timestamp: Date.now(),
    };

    await transmit.append(event);

    const events = await transmit.read(sessionId);
    expect(events).toHaveLength(1);
    const result = events[0]!.content[0]!;
    expect(result.type).toBe("tool_result");
    if (result.type === "tool_result") {
      expect(result.content).toBe(largeContent);
      expect(result.content.length).toBe(128 * 1024);
    }
  });
});
