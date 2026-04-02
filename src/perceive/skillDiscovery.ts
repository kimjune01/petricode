import { readFile, readdir } from "fs/promises";
import { join } from "path";
import type { Skill } from "../core/types.js";

const VALID_TRIGGERS = new Set(["slash_command", "auto", "manual"]);

/**
 * Scan a directory for markdown files with YAML frontmatter.
 * Parse frontmatter with regex (no YAML library).
 */
export async function discoverSkills(skillDir: string): Promise<Skill[]> {
  const skills: Skill[] = [];

  let entries: string[];
  try {
    entries = await readdir(skillDir);
  } catch {
    return skills;
  }

  for (const file of entries) {
    if (!file.endsWith(".md")) continue;
    const path = join(skillDir, file);
    try {
      const raw = await readFile(path, "utf-8");
      const parsed = parseFrontmatter(raw);
      if (!parsed) continue;

      const { frontmatter, body } = parsed;
      const name = frontmatter.name;
      const trigger = frontmatter.trigger;

      if (typeof name !== "string" || !name) continue;
      if (typeof trigger !== "string" || !VALID_TRIGGERS.has(trigger)) continue;

      skills.push({
        name,
        body,
        frontmatter,
        trigger: trigger as Skill["trigger"],
      });
    } catch {
      // unreadable file — skip
    }
  }

  return skills;
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
