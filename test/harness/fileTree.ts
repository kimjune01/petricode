// ── Declarative filesystem helper ───────────────────────────────

import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export interface FileTree {
  [key: string]: string | FileTree;
}

/** Write a tree of files into baseDir. Nested objects create subdirectories. */
export function writeTree(baseDir: string, tree: FileTree): void {
  for (const [name, value] of Object.entries(tree)) {
    const fullPath = join(baseDir, name);
    if (typeof value === "string") {
      writeFileSync(fullPath, value, "utf-8");
    } else {
      mkdirSync(fullPath, { recursive: true });
      writeTree(fullPath, value);
    }
  }
}

/** Create a temp directory and populate it from a FileTree. Returns the path. */
export async function createTestDir(structure: FileTree): Promise<string> {
  const dir = join(tmpdir(), `petricode-test-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  writeTree(dir, structure);
  return dir;
}

/** Remove a test directory created by createTestDir. */
export async function cleanupTestDir(dir: string): Promise<void> {
  rmSync(dir, { recursive: true, force: true });
}
