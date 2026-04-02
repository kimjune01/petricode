import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createSqliteRemember } from "../src/remember/sqlite.js";
import { createConsolidator, groupTriples } from "../src/consolidate/consolidator.js";
import { parseTriples } from "../src/consolidate/extractor.js";
import { runConsolidate, writeApproved } from "../src/commands/consolidate.js";
import type { Provider } from "../src/providers/provider.js";
import type { Message, StreamChunk, Session, CandidateSkill, PerceivedEvent } from "../src/core/types.js";
import type { ModelConfig } from "../src/providers/provider.js";
import type { ReviewDecision } from "../src/app/components/ConsolidateReview.js";

// ── Mock provider ────────────────────────────────────────────────

function mockProvider(responses: string[], id: string = "mock"): Provider {
  let callIndex = 0;
  return {
    model_id: () => id,
    token_limit: () => 100_000,
    supports_tools: () => false,
    async *generate(
      _prompt: Message[],
      _config: ModelConfig,
    ): AsyncGenerator<StreamChunk> {
      const text = responses[callIndex] ?? responses[responses.length - 1]!;
      callIndex++;
      yield { type: "content_delta", text };
      yield { type: "done" };
    },
  };
}

// ── Test sessions ────────────────────────────────────────────────

function makeSession(id: string, messages: string[]): Session {
  return {
    id,
    turns: messages.map((text, i) => ({
      id: `${id}-turn-${i}`,
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: [{ type: "text" as const, text }],
      timestamp: Date.now() + i * 1000,
    })),
    metadata: {},
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe("parseTriples", () => {
  test("parses well-formed lines", () => {
    const raw = [
      "PROBLEM: flaky tests | APPROACH: add retries | OUTCOME: tests stabilized",
      "PROBLEM: slow builds | APPROACH: parallel compilation | OUTCOME: 3x speedup",
      "",
      "Some noise line",
    ].join("\n");

    const triples = parseTriples(raw, "sess-1");
    expect(triples).toHaveLength(2);
    expect(triples[0]!.problem).toBe("flaky tests");
    expect(triples[0]!.approach).toBe("add retries");
    expect(triples[0]!.outcome).toBe("tests stabilized");
    expect(triples[0]!.session_id).toBe("sess-1");
    expect(triples[1]!.problem).toBe("slow builds");
  });

  test("returns empty array for no matches", () => {
    expect(parseTriples("nothing useful here", "s1")).toHaveLength(0);
  });
});

describe("groupTriples", () => {
  test("groups triples with overlapping problem words", () => {
    const triples = [
      { problem: "flaky integration tests", approach: "a1", outcome: "o1", session_id: "s1" },
      { problem: "flaky integration suite", approach: "a2", outcome: "o2", session_id: "s2" },
      { problem: "slow build times", approach: "a3", outcome: "o3", session_id: "s3" },
    ];

    const groups = groupTriples(triples);
    // First two share "flaky" and "integration", third is separate
    expect(groups.length).toBe(2);

    const flaky = groups.find((g) => g.some((t) => t.problem.includes("flaky")))!;
    expect(flaky).toHaveLength(2);
  });

  test("empty input returns empty groups", () => {
    expect(groupTriples([])).toHaveLength(0);
  });
});

describe("Consolidator", () => {
  test("extracts and returns candidate skills", async () => {
    // Fast model returns predictable triples
    const fast = mockProvider([
      // Session 1
      "PROBLEM: error handling missing | APPROACH: add try-catch | OUTCOME: errors caught",
      // Session 2
      "PROBLEM: error handling missing | APPROACH: wrap in try-catch | OUTCOME: stable",
      // Session 3
      "PROBLEM: error handling gaps | APPROACH: add error boundaries | OUTCOME: resilient",
    ]);

    // Primary and reviewer for volley — converge immediately
    const primary = mockProvider(["polished skill body"]);
    const reviewer = mockProvider(["NO_ISSUES"]);

    const consolidator = createConsolidator({ fast, primary, reviewer });

    const sessions = [
      makeSession("s1", ["fix the crashes", "added try-catch blocks"]),
      makeSession("s2", ["handle errors", "wrapped in try-catch"]),
      makeSession("s3", ["error handling", "added error boundaries"]),
    ];

    const candidates = await consolidator.run(sessions);

    expect(candidates.length).toBeGreaterThanOrEqual(1);

    const first = candidates[0]!;
    expect(first.name).toBeTruthy();
    expect(first.body).toBeTruthy();
    expect(first.confidence).toBeGreaterThan(0);
    expect(first.source_sessions.length).toBeGreaterThanOrEqual(1);
  });

  test("returns empty for sessions with no patterns", async () => {
    const fast = mockProvider(["No clear patterns found."]);
    const primary = mockProvider(["polished"]);
    const reviewer = mockProvider(["NO_ISSUES"]);

    const consolidator = createConsolidator({ fast, primary, reviewer });
    const sessions = [makeSession("s1", ["hi", "hello"])];

    const candidates = await consolidator.run(sessions);
    expect(candidates).toHaveLength(0);
  });
});

describe("ConsolidateCommand", () => {
  let tmpDir: string;
  let remember: ReturnType<typeof createSqliteRemember>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "petricode-consolidate-"));
    remember = createSqliteRemember({
      dataDir: join(tmpDir, "data"),
      skillsDir: join(tmpDir, "skills"),
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("runConsolidate reports no sessions", async () => {
    const fast = mockProvider([""]);
    const primary = mockProvider([""]);
    const reviewer = mockProvider(["NO_ISSUES"]);
    const consolidator = createConsolidator({ fast, primary, reviewer });

    const result = await runConsolidate({ remember, consolidator });
    expect(result.output).toContain("No sessions");
  });

  test("writeApproved writes skill to disk", async () => {
    const candidate: CandidateSkill = {
      name: "error-handling",
      body: "When errors occur, add try-catch.",
      confidence: 0.8,
      source_sessions: ["s1", "s2"],
    };

    const decisions: ReviewDecision[] = [
      { candidate, action: "approve" },
    ];

    const result = await writeApproved(remember, decisions);
    expect(result).toContain("Wrote 1 skill");

    // Verify skill exists on disk with valid frontmatter
    const skills = await remember.read_skills!();
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("error-handling");
    expect(skills[0]!.body).toBe("When errors occur, add try-catch.");
    expect(skills[0]!.frontmatter.confidence).toBe(0.8);
    expect(skills[0]!.frontmatter.generated).toBe(true);
    expect(skills[0]!.trigger).toBe("manual");
  });

  test("writeApproved skips rejected candidates", async () => {
    const candidate: CandidateSkill = {
      name: "rejected-skill",
      body: "Should not be written.",
      confidence: 0.2,
      source_sessions: ["s1"],
    };

    const decisions: ReviewDecision[] = [
      { candidate, action: "reject" },
    ];

    const result = await writeApproved(remember, decisions);
    expect(result).toContain("No skills approved");

    const skills = await remember.read_skills!();
    expect(skills).toHaveLength(0);
  });

  test("end-to-end: seed sessions, consolidate, approve, verify on disk", async () => {
    // Seed sessions
    for (const sid of ["sess-1", "sess-2", "sess-3"]) {
      const event: PerceivedEvent = {
        kind: "perceived",
        source: sid,
        content: [{ type: "text", text: `discussion in ${sid}` }],
        timestamp: Date.now(),
      };
      await remember.append(event);
    }

    const fast = mockProvider([
      "PROBLEM: error handling missing | APPROACH: add try-catch | OUTCOME: errors caught",
    ]);
    const primary = mockProvider(["polished: add error boundaries around risky code"]);
    const reviewer = mockProvider(["NO_ISSUES"]);

    const consolidator = createConsolidator({
      fast,
      primary,
      reviewer,
      listDecisions: () => remember.list_decisions!(),
    });

    // Run consolidation
    const sessions = await remember.list();
    const candidates = await consolidator.run(sessions);
    expect(candidates.length).toBeGreaterThanOrEqual(1);

    // Approve all
    const decisions: ReviewDecision[] = candidates.map((c) => ({
      candidate: c,
      action: "approve" as const,
    }));

    await writeApproved(remember, decisions);

    // Verify on disk
    const skills = await remember.read_skills!();
    expect(skills.length).toBeGreaterThanOrEqual(1);
    expect(skills[0]!.frontmatter.generated).toBe(true);
    expect(skills[0]!.frontmatter.source_sessions).toBeTruthy();
  });
});
