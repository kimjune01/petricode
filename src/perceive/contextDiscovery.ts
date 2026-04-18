import { readFile, readdir, stat } from "fs/promises";
import { join } from "path";
import type { ContextFragment } from "../core/types.js";
import { isAlwaysExcluded, loadIgnorePredicate } from "../filter/gitignore.js";

const INSTRUCTION_FILES = ["instructions.md", "CLAUDE.md", "AGENTS.md", "README.md"];

/**
 * Discover context fragments by walking for instruction files.
 * Precedence: global (0.3) < project (0.7) < subdirectory (0.9).
 */
export async function discoverContext(
  projectDir: string,
  globalConfigDir?: string
): Promise<ContextFragment[]> {
  const fragments: ContextFragment[] = [];

  // Global config
  if (globalConfigDir) {
    for (const file of INSTRUCTION_FILES) {
      const p = join(globalConfigDir, file);
      const content = await tryRead(p);
      if (content !== null) {
        fragments.push({ source: p, content, relevance: 0.3 });
      }
    }
  }

  // Project-root instruction files (CLAUDE.md, AGENTS.md, etc.)
  for (const file of INSTRUCTION_FILES) {
    const p = join(projectDir, file);
    const content = await tryRead(p);
    if (content !== null) {
      fragments.push({ source: p, content, relevance: 0.5 });
    }
  }

  // Project-level .agents/
  const projectAgents = join(projectDir, ".agents");
  await collectFromDir(projectAgents, fragments, 0.7);

  // Subdirectory .agents/ — one level deep. Skip always-excluded dirs
  // AND anything the project's own .gitignore opts out of, so we don't
  // walk into `vendor/`, `dist/`, or any user-defined ignore dir
  // chasing context fragments that don't exist.
  try {
    const isIgnored = await loadIgnorePredicate(projectDir);
    const entries = await readdir(projectDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (isAlwaysExcluded(entry.name)) continue;
      if (isIgnored(entry.name, true)) continue;
      const subAgents = join(projectDir, entry.name, ".agents");
      await collectFromDir(subAgents, fragments, 0.9);
    }
  } catch {
    // projectDir might not exist
  }

  // Sort by relevance ascending (global first, subdirectory last)
  fragments.sort((a, b) => a.relevance - b.relevance);

  return fragments;
}

async function collectFromDir(
  dir: string,
  fragments: ContextFragment[],
  relevance: number
): Promise<void> {
  try {
    const entries = await readdir(dir);
    for (const file of entries) {
      if (!file.endsWith(".md")) continue;
      const p = join(dir, file);
      const content = await tryRead(p);
      if (content !== null) {
        fragments.push({ source: p, content, relevance });
      }
    }
  } catch {
    // dir doesn't exist — fine
  }
}

async function tryRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}
