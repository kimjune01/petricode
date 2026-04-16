import type { Skill } from "../core/types.js";
import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from "fs";
import { join, resolve, sep } from "path";

// Skill names map to filenames inside skillsDir. They must be opaque
// identifiers, NOT paths — a name like "../foo" would otherwise escape
// the skills directory via path.join's `..` collapsing. Allow only
// letters/digits/underscore/hyphen.
const SAFE_SKILL_NAME = /^[A-Za-z0-9_\-]+$/;

function assertSafeSkillName(name: string): void {
  if (!SAFE_SKILL_NAME.test(name)) {
    throw new Error(
      `SkillStore: invalid skill name '${name}' — must match ${SAFE_SKILL_NAME}`,
    );
  }
}

export class SkillStore {
  private skillsDir: string;

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
    if (!existsSync(this.skillsDir)) {
      mkdirSync(this.skillsDir, { recursive: true });
    }
  }

  private skillPath(name: string): string {
    assertSafeSkillName(name);
    const candidate = resolve(this.skillsDir, `${name}.md`);
    const root = resolve(this.skillsDir);
    // Defense in depth: even after the regex check, verify the resolved
    // path stays inside skillsDir.
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      throw new Error(`SkillStore: name '${name}' escapes skills directory`);
    }
    return candidate;
  }

  private serializeSkill(skill: Skill): string {
    const lines = ["---"];
    lines.push(`name: ${skill.name}`);
    for (const [key, value] of Object.entries(skill.frontmatter)) {
      if (key === "name") continue; // already written above
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
    lines.push(`trigger: ${skill.trigger}`);
    lines.push("---");
    lines.push("");
    lines.push(skill.body);
    return lines.join("\n");
  }

  private parseSkill(name: string, raw: string): Skill {
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n\r?\n?([\s\S]*)$/);
    if (!fmMatch) {
      return { name, body: raw, frontmatter: {}, trigger: "manual" };
    }

    const fmBlock = fmMatch[1]!;
    const body = fmMatch[2] ?? "";
    const frontmatter: Record<string, unknown> = {};
    let trigger: Skill["trigger"] = "manual";

    for (const line of fmBlock.split("\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const rawValue = line.slice(colonIdx + 1).trim();
      let value: unknown;
      try {
        value = JSON.parse(rawValue);
      } catch {
        value = rawValue;
      }
      if (key === "trigger") {
        trigger = value as Skill["trigger"];
      } else {
        frontmatter[key] = value;
      }
    }

    return { name, body, frontmatter, trigger };
  }

  write(skill: Skill): void {
    writeFileSync(this.skillPath(skill.name), this.serializeSkill(skill));
  }

  readAll(): Skill[] {
    if (!existsSync(this.skillsDir)) return [];
    const files = readdirSync(this.skillsDir).filter((f) => f.endsWith(".md"));
    return files.map((f) => {
      const name = f.replace(/\.md$/, "");
      const raw = readFileSync(join(this.skillsDir, f), "utf-8");
      return this.parseSkill(name, raw);
    });
  }

  delete(name: string): boolean {
    const path = this.skillPath(name);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  }
}
