// ── WorkspaceFixture — isolated project + home dirs for tests ───

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeTree, type FileTree } from "./fileTree.js";

export class WorkspaceFixture {
  readonly testDir: string;
  readonly homeDir: string;
  readonly dataDir: string;

  constructor(testName: string) {
    const base = join(tmpdir(), `petricode-${testName}-${crypto.randomUUID()}`);
    this.testDir = join(base, "project");
    this.homeDir = join(base, "home");
    this.dataDir = join(this.homeDir, ".config", "petricode", "data", "test");
  }

  async setup(options?: {
    projectFiles?: FileTree;
    skills?: FileTree;
  }): Promise<void> {
    // Create directory structure
    mkdirSync(this.testDir, { recursive: true });
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(join(this.homeDir, ".config", "petricode", "skills"), {
      recursive: true,
    });

    // Write project files
    if (options?.projectFiles) {
      writeTree(this.testDir, options.projectFiles);
    }

    // Write skills
    if (options?.skills) {
      writeTree(
        join(this.homeDir, ".config", "petricode", "skills"),
        options.skills,
      );
    }
  }

  createFile(relativePath: string, content: string): void {
    const fullPath = join(this.testDir, relativePath);
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content, "utf-8");
  }

  readFile(relativePath: string): string {
    return readFileSync(join(this.testDir, relativePath), "utf-8");
  }

  fileExists(relativePath: string): boolean {
    return existsSync(join(this.testDir, relativePath));
  }

  async cleanup(): Promise<void> {
    // testDir and homeDir share a common parent
    const base = join(this.testDir, "..");
    rmSync(base, { recursive: true, force: true });
  }
}
