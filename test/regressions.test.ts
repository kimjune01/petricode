import { describe, test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { buildIgnorePredicate } from "../src/filter/gitignore.js";
import { expandFileRefs } from "../src/perceive/fileRefs.js";

// ── Round 20 #3: gitignore globstar `?` corruption ───────────────
// patternToRegex used to run `?` → `[^/]` AFTER expanding `**` into
// regex strings containing literal `?` quantifiers (`(/.*)?/`). That
// broke any pattern using `**`. Order is now `?` first.

describe("gitignore globstar/?? regression", () => {
  test("`src/**/*.ts` matches src/a.ts and src/x/y/a.ts", () => {
    const isIgnored = buildIgnorePredicate(["src/**/*.ts"]);
    expect(isIgnored("src/a.ts")).toBe(true);
    expect(isIgnored("src/x/y/a.ts")).toBe(true);
    expect(isIgnored("src/a.js")).toBe(false);
  });

  test("`?` glob still matches a single non-slash char", () => {
    const isIgnored = buildIgnorePredicate(["log?.txt"]);
    expect(isIgnored("log1.txt")).toBe(true);
    expect(isIgnored("logA.txt")).toBe(true);
    expect(isIgnored("log.txt")).toBe(false);
    expect(isIgnored("log12.txt")).toBe(false);
  });
});

// ── Round 20 #4: @file ref size cap ──────────────────────────────
// expandFileRefs used raw readFile() with no size check, so an
// `@huge.log` mention could OOM the agent. Now it stat-checks and
// truncates with a marker, mirroring ReadFileTool.

describe("@file ref size cap", () => {
  test("files above 256KB are truncated with a marker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "petricode-fileref-"));
    try {
      const path = join(dir, "huge.txt");
      const big = "x".repeat(300_000);
      await writeFile(path, big);
      const out = await expandFileRefs("see @huge.txt", dir);
      expect(out).toContain("[truncated");
      expect(out).toContain("300000 bytes");
      expect(out.length).toBeLessThan(big.length);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("small files inline in full, untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "petricode-fileref-"));
    try {
      const path = join(dir, "small.txt");
      await writeFile(path, "hello world");
      const out = await expandFileRefs("see @small.txt", dir);
      expect(out).toContain("hello world");
      expect(out).not.toContain("[truncated");
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
