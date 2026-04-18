import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadSkillsFromDirs } from "../src/skiller/cache.js";
import { matchSlashCommand, matchAutoTriggers } from "../src/skiller/filter.js";
import { substituteArguments } from "../src/skiller/consolidator.js";
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

  test("**/*.ext glob matches nested paths and doesn't throw", async () => {
    writeSkill(
      globalDir,
      "ts-helper.md",
      `---
name: ts-helper
trigger: auto
paths: "**/*.ts"
---
Help with TS.`,
    );
    const skills = await loadSkillsFromDirs(globalDir, projectDir);
    // Pre-fix bug: this regex was `^**/*\.ts$` (invalid), threw silently,
    // returned false for every input. Now nested .ts paths match.
    expect(matchAutoTriggers("touching deep/nested/file.ts now", skills)).toHaveLength(1);
    expect(matchAutoTriggers("touching deep/nested/file.js now", skills)).toHaveLength(0);
  });

  test("dir/*.ext glob matches a path segment, not the directory itself", async () => {
    writeSkill(
      globalDir,
      "src-helper.md",
      `---
name: src-helper
trigger: auto
paths: "src/*.ts"
---
Help with src TS files.`,
    );
    const skills = await loadSkillsFromDirs(globalDir, projectDir);
    expect(matchAutoTriggers("editing src/cache.ts here", skills)).toHaveLength(1);
    // Pre-fix bug: the degenerate `0+ /` quantifier matched `src.ts` (no slash).
    expect(matchAutoTriggers("editing src.ts here", skills)).toHaveLength(0);
    // `*` is single-segment — should not cross slash boundaries.
    expect(matchAutoTriggers("editing src/sub/cache.ts here", skills)).toHaveLength(0);
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

// ── Claude Code skill compatibility ─────────────────────────────

describe("Claude SKILL.md compatibility", () => {
  test("discovers <dir>/<name>/SKILL.md layout", async () => {
    const skillDir = join(globalDir, "bug-hunt");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: bug-hunt
description: Adversarial review loop
---
Review the code carefully.`,
    );

    const skills = await loadSkillsFromDirs(globalDir, projectDir);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("bug-hunt");
    expect(skills[0]!.body).toBe("Review the code carefully.");
  });

  test("missing trigger defaults to manual", async () => {
    const skillDir = join(globalDir, "claude-style");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: claude-style
description: A skill without a trigger field
---
Do the thing.`,
    );

    const skills = await loadSkillsFromDirs(globalDir, projectDir);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.trigger).toBe("manual");
  });

  test("infers name from directory when frontmatter omits it", async () => {
    const skillDir = join(globalDir, "inferred-name");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
description: Name comes from the dir
---
Body.`,
    );

    const skills = await loadSkillsFromDirs(globalDir, projectDir);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("inferred-name");
  });

  test("flat .md and SKILL.md coexist in the same dir", async () => {
    writeSkill(
      globalDir,
      "flat.md",
      `---
name: flat
trigger: manual
---
Flat skill body.`,
    );
    const subDir = join(globalDir, "nested");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, "SKILL.md"),
      `---
name: nested
---
Nested skill body.`,
    );

    const skills = await loadSkillsFromDirs(globalDir, projectDir);
    expect(skills).toHaveLength(2);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["flat", "nested"]);
  });
});

// ── Skill tool ──────────────────────────────────────────────────

describe("Skill tool", () => {
  test("returns body with $ARGUMENTS substituted", async () => {
    const { createSkillTool } = await import("../src/tools/skill.js");
    const tool = createSkillTool([
      {
        name: "greet",
        body: "Say hello to $ARGUMENTS.",
        frontmatter: {},
        trigger: "manual",
      },
    ]);

    const result = await tool.execute({ name: "greet", arguments: "Alice" });
    expect(result).toBe("Say hello to Alice.");
  });

  test("errors on unknown skill name", async () => {
    const { createSkillTool } = await import("../src/tools/skill.js");
    const tool = createSkillTool([
      { name: "known", body: "ok", frontmatter: {}, trigger: "manual" },
    ]);

    const result = await tool.execute({ name: "missing" });
    expect(result).toContain("unknown skill");
    expect(result).toContain("known");
  });

  test("works without arguments", async () => {
    const { createSkillTool } = await import("../src/tools/skill.js");
    const tool = createSkillTool([
      { name: "static", body: "no substitution here", frontmatter: {}, trigger: "manual" },
    ]);

    const result = await tool.execute({ name: "static" });
    expect(result).toBe("no substitution here");
  });
});
