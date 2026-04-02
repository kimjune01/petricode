import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { expandFileRefs } from "../src/perceive/fileRefs.js";
import { discoverContext } from "../src/perceive/contextDiscovery.js";
import { discoverSkills } from "../src/perceive/skillDiscovery.js";
import { Perceiver } from "../src/perceive/perceiver.js";

// ── Helpers ─────────────────────────────────────────────────────

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "petricode-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── fileRefs ────────────────────────────────────────────────────

describe("fileRefs", () => {
  test("@file reference expands to file contents", async () => {
    const filePath = join(tmp, "hello.txt");
    writeFileSync(filePath, "world");
    const result = await expandFileRefs(`check @${filePath} please`);
    expect(result).toContain("world");
    expect(result).toContain(filePath);
  });

  test("missing @file produces error marker", async () => {
    const result = await expandFileRefs(`look at @${tmp}/nope.txt`);
    expect(result).toContain("[file not found");
  });

  test("no @file refs returns input unchanged", async () => {
    const result = await expandFileRefs("plain text no refs");
    expect(result).toBe("plain text no refs");
  });
});

// ── contextDiscovery ────────────────────────────────────────────

describe("contextDiscovery", () => {
  test("finds .agents/instructions.md in project dir", async () => {
    const agentsDir = join(tmp, ".agents");
    mkdirSync(agentsDir);
    writeFileSync(join(agentsDir, "instructions.md"), "# Project rules\nDo stuff.");

    const fragments = await discoverContext(tmp);
    const found = fragments.find((f) => f.source.includes(".agents/instructions.md"));
    expect(found).toBeDefined();
    expect(found!.content).toContain("Do stuff.");
  });

  test("precedence: global < project (project has higher relevance)", async () => {
    // Global
    const globalDir = join(tmp, "global-config");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "instructions.md"), "global rules");

    // Project
    const agentsDir = join(tmp, ".agents");
    mkdirSync(agentsDir);
    writeFileSync(join(agentsDir, "instructions.md"), "project rules");

    const fragments = await discoverContext(tmp, globalDir);
    const global = fragments.find((f) => f.source.includes("global-config"));
    const project = fragments.find((f) => f.source.includes(".agents/instructions.md"));

    expect(global).toBeDefined();
    expect(project).toBeDefined();
    expect(project!.relevance).toBeGreaterThan(global!.relevance);
  });

  test("subdirectory .agents/ discovered with highest relevance", async () => {
    const subDir = join(tmp, "sub", ".agents");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "instructions.md"), "sub rules");

    const fragments = await discoverContext(tmp);
    const found = fragments.find((f) => f.source.includes("sub/.agents/instructions.md"));
    expect(found).toBeDefined();
    expect(found!.relevance).toBe(0.9);
  });

  test("AGENTS.md recognized as instruction file", async () => {
    const globalDir = join(tmp, "global-config");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "AGENTS.md"), "agent instructions");

    const fragments = await discoverContext(tmp, globalDir);
    const found = fragments.find((f) => f.source.includes("AGENTS.md"));
    expect(found).toBeDefined();
    expect(found!.content).toContain("agent instructions");
  });

  test("subdirectory relevance > project relevance > global relevance", async () => {
    // Global
    const globalDir = join(tmp, "global-config");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "instructions.md"), "global rules");

    // Project
    const agentsDir = join(tmp, ".agents");
    mkdirSync(agentsDir);
    writeFileSync(join(agentsDir, "instructions.md"), "project rules");

    // Subdirectory
    const subDir = join(tmp, "sub", ".agents");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "instructions.md"), "sub rules");

    const fragments = await discoverContext(tmp, globalDir);
    const global = fragments.find((f) => f.source.includes("global-config"));
    const project = fragments.find((f) => f.source.includes(join(tmp, ".agents")));
    const sub = fragments.find((f) => f.source.includes("sub/.agents"));

    expect(global!.relevance).toBe(0.3);
    expect(project!.relevance).toBe(0.7);
    expect(sub!.relevance).toBe(0.9);
  });
});

// ── skillDiscovery ──────────────────────────────────────────────

describe("skillDiscovery", () => {
  test("valid skill parsed correctly", async () => {
    const skillDir = join(tmp, "skills");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "greet.md"),
      `---
name: greet
trigger: slash_command
description: Greet the user
---
Say hello to the user.`
    );

    const skills = await discoverSkills(skillDir);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("greet");
    expect(skills[0]!.trigger).toBe("slash_command");
    expect(skills[0]!.body).toContain("Say hello");
    expect(skills[0]!.frontmatter).toHaveProperty("description", "Greet the user");
  });

  test("malformed skill frontmatter rejected", async () => {
    const skillDir = join(tmp, "skills");
    mkdirSync(skillDir);
    // Missing closing ---
    writeFileSync(
      join(skillDir, "bad.md"),
      `---
name: bad
trigger: slash_command
This has no closing fence so it's malformed.`
    );

    const skills = await discoverSkills(skillDir);
    expect(skills).toHaveLength(0);
  });

  test("skill without required fields rejected", async () => {
    const skillDir = join(tmp, "skills");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "noname.md"),
      `---
trigger: auto
---
Body here.`
    );

    const skills = await discoverSkills(skillDir);
    expect(skills).toHaveLength(0);
  });

  test("empty skill directory returns empty array", async () => {
    const skillDir = join(tmp, "skills");
    mkdirSync(skillDir);
    const skills = await discoverSkills(skillDir);
    expect(skills).toHaveLength(0);
  });
});

// ── Perceiver (integration) ─────────────────────────────────────

describe("Perceiver", () => {
  test("perceive returns PerceivedEvent with expanded refs", async () => {
    const filePath = join(tmp, "data.txt");
    writeFileSync(filePath, "important data");

    const perceiver = new Perceiver({ projectDir: tmp });
    const result = await perceiver.perceive(`read @${filePath}`);

    expect(result.kind).toBe("perceived");
    if ("content" in result) {
      const text = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      expect(text).toContain("important data");
    }
  });
});
