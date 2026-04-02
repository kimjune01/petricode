// ── Skill loader ────────────────────────────────────────────────
// Discovers skills from global + project dirs. Project wins on name collision.

import { join } from "path";
import { homedir } from "os";
import { discoverSkills } from "../perceive/skillDiscovery.js";
import type { Skill } from "../core/types.js";

const GLOBAL_SKILLS_DIR = join(homedir(), ".config", "petricode", "skills");

/**
 * Load skills from global and project directories.
 * Project skills override global skills with the same name.
 */
export async function loadSkills(projectDir: string): Promise<Skill[]> {
  const projectSkillsDir = join(projectDir, ".petricode", "skills");

  const globalSkills = await discoverSkills(GLOBAL_SKILLS_DIR);
  const projectSkills = await discoverSkills(projectSkillsDir);

  // Project overrides global — index by name
  const byName = new Map<string, Skill>();
  for (const s of globalSkills) {
    byName.set(s.name, s);
  }
  for (const s of projectSkills) {
    byName.set(s.name, s);
  }

  return Array.from(byName.values());
}

/**
 * Load from explicit directories (for testing).
 */
export async function loadSkillsFromDirs(
  globalDir: string,
  projectDir: string,
): Promise<Skill[]> {
  const globalSkills = await discoverSkills(globalDir);
  const projectSkills = await discoverSkills(projectDir);

  const byName = new Map<string, Skill>();
  for (const s of globalSkills) {
    byName.set(s.name, s);
  }
  for (const s of projectSkills) {
    byName.set(s.name, s);
  }

  return Array.from(byName.values());
}
