// ── Skill registry (Cache) ──────────────────────────────────────
// Holds the loaded skill set keyed by name with claude < global <
// project precedence. Cache stage in the PCFACT pipe: takes the raw
// Skill[] streams produced by perceive/skillDiscovery and indexes them
// for retrieval-by-name in the Filter (matcher) and Tool layers.

import { join } from "path";
import { homedir } from "os";
import { discoverSkills } from "../perceive/skillDiscovery.js";
import type { Skill } from "../core/types.js";

const GLOBAL_SKILLS_DIR = join(homedir(), ".config", "petricode", "skills");
const CLAUDE_SKILLS_DIR = join(homedir(), ".claude", "skills");

/**
 * Load skills from claude + global + project directories.
 * Claude < global < project on name collision.
 */
export async function loadSkills(projectDir: string): Promise<Skill[]> {
  const projectSkillsDir = join(projectDir, ".petricode", "skills");

  const [claudeSkills, globalSkills, projectSkills] = await Promise.all([
    discoverSkills(CLAUDE_SKILLS_DIR),
    discoverSkills(GLOBAL_SKILLS_DIR),
    discoverSkills(projectSkillsDir),
  ]);

  return mergeByName(claudeSkills, globalSkills, projectSkills);
}

/**
 * Load from explicit directories (for testing).
 * Order: lowest precedence first, highest last.
 */
export async function loadSkillsFromDirs(
  ...dirs: string[]
): Promise<Skill[]> {
  const sets = await Promise.all(dirs.map((d) => discoverSkills(d)));
  return mergeByName(...sets);
}

function mergeByName(...sets: Skill[][]): Skill[] {
  const byName = new Map<string, Skill>();
  for (const set of sets) {
    for (const s of set) {
      byName.set(s.name, s);
    }
  }
  return Array.from(byName.values());
}
