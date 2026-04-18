import { describe, test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { buildIgnorePredicate } from "../src/filter/gitignore.js";
import { expandFileRefs } from "../src/perceive/fileRefs.js";
import { UnionFindCache } from "../src/cache/cache.js";
import type { Turn } from "../src/core/types.js";

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

// ── Round 25 #2: gitignore directory-only patterns ───────────────
// Trailing-slash patterns (`dist/`) MUST only match directories per
// gitignore spec. Before the fix, `patternToRegex` stripped the slash
// silently and any file named `dist` was also hidden. The glob tool
// (which only yields files) was the visible victim.

describe("gitignore directory-only patterns", () => {
  test("`dist/` ignores the dist directory but not a file named dist", () => {
    const isIgnored = buildIgnorePredicate(["dist/"]);
    // Caller asserts the path is a regular file → dirOnly skipped.
    expect(isIgnored("dist", false)).toBe(false);
    // Caller asserts the path is a directory → match.
    expect(isIgnored("dist", true)).toBe(true);
    // Path inside the ignored dir is matched regardless of caller hint.
    expect(isIgnored("dist/index.js", false)).toBe(true);
  });

  test("non-dirOnly patterns still match files", () => {
    const isIgnored = buildIgnorePredicate(["*.log"]);
    expect(isIgnored("debug.log", false)).toBe(true);
  });

  // Regression for the leaf-greedy regex created by round 1's dirOnly fix:
  // `a/**/` should ignore `a/foo/file.txt`, but a greedy `.*` consumed
  // `foo/file.txt` so the match landed on the leaf and got skipped.
  test("globstar dir patterns ignore children, not just the dir", () => {
    const isIgnored = buildIgnorePredicate(["a/**/"]);
    expect(isIgnored("a/foo/file.txt", false)).toBe(true);
    expect(isIgnored("a/foo", true)).toBe(true);
    expect(isIgnored("a/foo", false)).toBe(false);
    expect(isIgnored("a", false)).toBe(false);
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

// ── Round 26 #4: compact() must not split tool_use/tool_result pairs ──
// append() already drags a tool_result into cold along with a graduated
// tool_use turn so the next API call doesn't see a dangling tool_result.
// compact() bypassed the same check — running /compact at the wrong
// boundary would split the pair and break the next turn.

describe("UnionFindCache.compact tool pair invariant", () => {
  test("compact graduates a tool_result alongside its preceding tool_use", () => {
    const cache = new UnionFindCache({ hot_capacity: 4 });
    const turns: Turn[] = [
      { id: "u1", role: "user", content: [{ type: "text", text: "a" }], timestamp: 1 },
      { id: "a1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }], timestamp: 2 },
      { id: "r1", role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }], timestamp: 3 },
      { id: "u2", role: "user", content: [{ type: "text", text: "b" }], timestamp: 4 },
    ];
    for (const t of turns) cache.append(t);

    cache.compact();

    // hot_capacity 4 → keep = ceil(4/2) = 2. compact() shifts u1, then
    // graduates a1; the tool-pair lookahead must drag r1 with it so r1
    // never lingers in hot without its tool_use partner.
    const hotIds = cache.read()
      .filter((t) => !t.id.startsWith("cluster_"))
      .map((t) => t.id);
    expect(hotIds).not.toContain("a1");
    expect(hotIds).not.toContain("r1");
    expect(hotIds).toContain("u2");
  });
});
