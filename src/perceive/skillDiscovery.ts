import { readFile, readdir } from "fs/promises";
import type { Dirent } from "fs";
import { join } from "path";
import type { Skill } from "../core/types.js";

const VALID_TRIGGERS = new Set(["slash_command", "auto", "manual"]);

/**
 * Scan a directory for skills. Two layouts are supported:
 *   1. Petricode flat:  <dir>/<name>.md
 *   2. Claude per-skill: <dir>/<name>/SKILL.md
 * Frontmatter without a `trigger:` field defaults to "manual" — Claude
 * skills don't carry triggers, so this is what makes them invocable.
 */
export async function discoverSkills(skillDir: string): Promise<Skill[]> {
  const skills: Skill[] = [];

  let entries: Dirent[];
  try {
    entries = (await readdir(skillDir, { withFileTypes: true })) as unknown as Dirent[];
  } catch {
    return skills;
  }

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      // Flat layout — name comes from filename
      const inferredName = entry.name.slice(0, -3);
      const skill = await readSkillFile(join(skillDir, entry.name), inferredName);
      if (skill) skills.push(skill);
    } else if (entry.isDirectory()) {
      // Claude per-skill layout — <dir>/SKILL.md (or skill.md). Match
      // case-insensitively so the same skill works on case-sensitive
      // filesystems (Linux) and case-insensitive ones (macOS APFS).
      const subDir = join(skillDir, entry.name);
      let subEntries: Dirent[];
      try {
        subEntries = (await readdir(subDir, { withFileTypes: true })) as unknown as Dirent[];
      } catch {
        continue;
      }
      const skillFile = subEntries.find(
        (e) => e.isFile() && e.name.toLowerCase() === "skill.md",
      );
      if (!skillFile) continue;
      const skill = await readSkillFile(join(subDir, skillFile.name), entry.name);
      if (skill) skills.push(skill);
    }
  }

  return skills;
}

async function readSkillFile(
  path: string,
  inferredName: string,
): Promise<Skill | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return null;
  }

  const parsed = parseFrontmatter(raw);
  if (!parsed) return null;

  const { frontmatter, body } = parsed;
  const name = typeof frontmatter.name === "string" && frontmatter.name
    ? frontmatter.name
    : inferredName;
  if (!name) return null;

  // Default to "manual" — Claude skills don't carry a trigger field.
  const rawTrigger = frontmatter.trigger;
  const trigger =
    typeof rawTrigger === "string" && VALID_TRIGGERS.has(rawTrigger)
      ? (rawTrigger as Skill["trigger"])
      : "manual";

  return { name, body, frontmatter, trigger };
}

/**
 * Parse YAML frontmatter delimited by --- fences.
 * Simple key: value parsing — no nested structures, no YAML library.
 */
function parseFrontmatter(
  raw: string
): { frontmatter: Record<string, unknown>; body: string } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;

  const yamlBlock = match[1]!;
  const body = match[2]!.trim();
  const frontmatter: Record<string, unknown> = {};

  for (const line of yamlBlock.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    frontmatter[key] = value;
  }

  return { frontmatter, body };
}
