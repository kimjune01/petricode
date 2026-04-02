import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadSkillsFromDirs } from "../src/skills/loader.js";
import {
  matchSlashCommand,
  matchAutoTriggers,
  substituteArguments,
} from "../src/skills/activation.js";
import { listSkills } from "../src/commands/skills.js";

// ── Helpers ─────────────────────────────────────────────────────

let tmp: string;
let globalDir: string;
let projectDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "petricode-skills-test-"));
  globalDir = join(tmp, "global");
  projectDir = join(tmp, "project");
  mkdirSync(globalDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeSkill(dir: string, filename: string, content: string): void {
  writeFileSync(join(dir, filename), content);
}

// ── Slash command activation ────────────────────────────────────

describe("slash command skill", () => {
  test("slash command activates matching skill", async () => {
    writeSkill(
      globalDir,
      "greet.md",
      `---
name: greet
trigger: slash_command
description: Greet the user
---
Respond with exactly: Hello from skill.`,
    );

    const skills = await loadSkillsFromDirs(globalDir, projectDir);
    expect(skills).toHaveLength(1);

    const match = matchSlashCommand("/greet", skills);
    expect(match).not.toBeNull();
    expect(match!.skill.name).toBe("greet");
    expect(match!.via).toBe("slash_command");

    const body = substituteArguments(match!.skill.body, match!.arguments);
    expect(body).toBe("Respond with exactly: Hello from skill.");
  });

  test("non-matching slash command returns null", async () => {
    writeSkill(
      globalDir,
      "greet.md",
      `---
name: greet
trigger: slash_command
---
Hello.`,
    );

    const skills = await loadSkillsFromDirs(globalDir, projectDir);
    const match = matchSlashCommand("/unknown", skills);
    expect(match).toBeNull();
  });
});

// ── Auto-trigger activation ─────────────────────────────────────

describe("auto-trigger skill", () => {
  test("activates when input mentions matching file", async () => {
    writeSkill(
      globalDir,
      "test-helper.md",
      `---
name: test-helper
trigger: auto
paths: "*.test.ts"
---
Run tests before committing.`,
    );

    const skills = await loadSkillsFromDirs(globalDir, projectDir);
    expect(skills).toHaveLength(1);

    const matches = matchAutoTriggers(
      "please fix src/cache.test.ts",
      skills,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.skill.name).toBe("test-helper");
    expect(matches[0]!.via).toBe("auto_trigger");
  });

  test("does not activate for non-matching files", async () => {
    writeSkill(
      globalDir,
      "test-helper.md",
      `---
name: test-helper
trigger: auto
paths: "*.test.ts"
---
Run tests before committing.`,
    );

    const skills = await loadSkillsFromDirs(globalDir, projectDir);
    const matches = matchAutoTriggers("edit src/cache.ts please", skills);
    expect(matches).toHaveLength(0);
  });
});

// ── /skills command ─────────────────────────────────────────────

describe("/skills command", () => {
  test("lists all loaded skills", async () => {
    writeSkill(
      globalDir,
      "greet.md",
      `---
name: greet
trigger: slash_command
description: Greet the user
---
Hello.`,
    );
    writeSkill(
      projectDir,
      "test-helper.md",
      `---
name: test-helper
trigger: auto
description: Helps with tests
paths: "*.test.ts"
---
Run tests.`,
    );

    const skills = await loadSkillsFromDirs(globalDir, projectDir);
    const result = listSkills(skills);
    expect(result.output).toContain("greet");
    expect(result.output).toContain("test-helper");
    expect(result.output).toContain("Greet the user");
    expect(result.output).toContain("Helps with tests");
  });

  test("shows empty message when no skills", () => {
    const result = listSkills([]);
    expect(result.output).toBe("No skills loaded.");
  });
});

// ── $ARGUMENTS substitution ─────────────────────────────────────

describe("$ARGUMENTS substitution", () => {
  test("replaces $ARGUMENTS with slash command args", async () => {
    writeSkill(
      globalDir,
      "tighten.md",
      `---
name: tighten
trigger: slash_command
---
Tighten the file at $ARGUMENTS. Remove filler.`,
    );

    const skills = await loadSkillsFromDirs(globalDir, projectDir);
    const match = matchSlashCommand("/tighten foo.ts", skills);
    expect(match).not.toBeNull();
    expect(match!.arguments).toBe("foo.ts");

    const body = substituteArguments(match!.skill.body, match!.arguments);
    expect(body).toBe("Tighten the file at foo.ts. Remove filler.");
  });

  test("multiple $ARGUMENTS occurrences all get replaced", () => {
    const body = "First: $ARGUMENTS, Second: $ARGUMENTS";
    const result = substituteArguments(body, "target.ts");
    expect(result).toBe("First: target.ts, Second: target.ts");
  });
});

// ── Project overrides global ────────────────────────────────────

describe("skill precedence", () => {
  test("project skill overrides global skill with same name", async () => {
    writeSkill(
      globalDir,
      "greet.md",
      `---
name: greet
trigger: slash_command
---
Global greeting.`,
    );
    writeSkill(
      projectDir,
      "greet.md",
      `---
name: greet
trigger: slash_command
---
Project greeting.`,
    );

    const skills = await loadSkillsFromDirs(globalDir, projectDir);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.body).toBe("Project greeting.");
  });
});
