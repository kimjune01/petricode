import { describe, test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { buildIgnorePredicate, parseGitignore } from "../src/filter/gitignore.js";
import { expandFileRefs } from "../src/perceive/fileRefs.js";
import { UnionFindCache } from "../src/cache/cache.js";
import { ReadFileTool } from "../src/tools/readFile.js";
import { WriteFileTool } from "../src/tools/writeFile.js";
import { EditTool } from "../src/tools/edit.js";
import { ShellTool } from "../src/tools/shell.js";
import { maskToolOutput } from "../src/filter/toolMasking.js";
import { stepLeft, stepRight } from "../src/app/components/Composer.js";
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

// ── Round 28 #1: gitignore backslash escapes ──────────────────────
// patternToRegex used to escape `\` as a regex metachar BEFORE the
// glob pass, so `file\*name` collapsed to a literal-backslash + glob
// `*` and matched `file\Aname` instead of `file*name`. The masking
// pass now stashes `\*`, `\?`, `\!` as placeholders before either
// substitution touches them.

describe("gitignore backslash escapes", () => {
  test("`file\\*name` matches literal `file*name`, not `file\\Aname`", () => {
    const isIgnored = buildIgnorePredicate(["file\\*name"]);
    expect(isIgnored("file*name")).toBe(true);
    expect(isIgnored("fileXname")).toBe(false);
  });

  test("`!literal` (escaped bang) is treated as ignore, not negation", () => {
    const isIgnored = buildIgnorePredicate(["\\!keep.txt"]);
    expect(isIgnored("!keep.txt")).toBe(true);
  });

  // Round 29 #1: prior masking used U+0001…U+0003 as placeholders.
  // A pattern or path containing those control chars literally would
  // be unmasked into a regex wildcard, turning a stray byte into `*`.
  test("literal control chars in pattern do not collide with mask markers", () => {
    const isIgnored = buildIgnorePredicate(["foo\u0001bar"]);
    expect(isIgnored("foo\u0001bar")).toBe(true);
    expect(isIgnored("fooXbar")).toBe(false);
  });
});

// ── Round 28 #2: file tools refuse non-regular files (FIFO hang) ──
// Without an isFile() guard, opening or writing a FIFO/character
// device blocks the agent until the other end speaks. file_read,
// file_write, and edit now stat first and refuse anything that isn't
// a regular file.

describe("file tools reject non-regular files", () => {
  test("file_read on a FIFO throws instead of hanging", async () => {
    const dir = await mkdtemp(join(tmpdir(), "petricode-fifo-"));
    try {
      const fifo = join(dir, "pipe");
      const r = spawnSync("mkfifo", [fifo]);
      if (r.status !== 0) return; // mkfifo unavailable — skip
      await expect(
        ReadFileTool.execute({ path: fifo }, { cwd: dir }),
      ).rejects.toThrow(/not a regular file/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("edit on a FIFO throws instead of hanging", async () => {
    const dir = await mkdtemp(join(tmpdir(), "petricode-fifo-"));
    try {
      const fifo = join(dir, "pipe");
      const r = spawnSync("mkfifo", [fifo]);
      if (r.status !== 0) return;
      await expect(
        EditTool.execute(
          { path: fifo, old_string: "a", new_string: "b" },
          { cwd: dir },
        ),
      ).rejects.toThrow(/not a regular file/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("file_write into an existing FIFO throws instead of hanging", async () => {
    const dir = await mkdtemp(join(tmpdir(), "petricode-fifo-"));
    try {
      const fifo = join(dir, "pipe");
      const r = spawnSync("mkfifo", [fifo]);
      if (r.status !== 0) return;
      await expect(
        WriteFileTool.execute({ path: fifo, content: "x" }, { cwd: dir }),
      ).rejects.toThrow(/not a regular file/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── Round 28 #3: shell tool preserves chronological output order ──
// Old shell.ts collected stdout/stderr into separate strings, then
// concatenated them at the end. The model would see all stdout
// followed by all stderr, hiding causal relationships in build/test
// output. Shared buffer now preserves arrival order.

describe("shell tool output ordering", () => {
  test("interleaved stdout/stderr surface in arrival order", async () => {
    // Three lines: stdout, stderr, stdout. With the old splitter the
    // last line would be dragged into the stdout block, leaving stderr
    // pinned at the end.
    const out = await ShellTool.execute(
      {
        command:
          "printf 'a\\n'; printf 'b\\n' >&2; sleep 0.05; printf 'c\\n'",
      },
      {},
    );
    const idxA = out.indexOf("a");
    const idxB = out.indexOf("b");
    const idxC = out.indexOf("c");
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThan(idxA);
    expect(idxC).toBeGreaterThan(idxB);
  });

  // Round 30 #1: signal-killed processes report code=null. The old
  // `if (code !== 0)` branch rendered the resulting output as
  // "[exit null]\n…" — confusing both LLM and user. Now signals get a
  // legible "[killed by SIGNAME]" prefix.
  test("signal-killed processes do not surface as `[exit null]`", async () => {
    const out = await ShellTool.execute(
      { command: "kill -TERM $$" },
      {},
    );
    expect(out).not.toContain("[exit null]");
    expect(out).toMatch(/\[killed by SIG/);
  });
});

// ── Round 31 #1: mask threshold must clear ReadFileTool's truncation ──
// ReadFileTool truncates to 256KB and appends an actionable suffix.
// If maskToolOutput's threshold is below ~64K tokens, that careful
// truncation is wiped to an opaque `[masked — N tokens]` blob — which
// is exactly the failure the readFile.ts comment warned against.

describe("maskToolOutput threshold respects readFile cap", () => {
  test("a 200KB readFile-style output passes through, not masked", () => {
    // Mirror ReadFileTool's max payload (200KB of content, well under
    // the 256KB cap, well over the old 10K-token threshold).
    const out = "x".repeat(200_000);
    const result = maskToolOutput(out);
    expect(result.masked).toBe(false);
    expect(result.content).toBe(out);
  });

  test("oversized output (e.g. 1MB shell flood) still gets masked", () => {
    const out = "x".repeat(1_000_000);
    const result = maskToolOutput(out);
    expect(result.masked).toBe(true);
    expect(result.content).toMatch(/\[masked/);
  });
});

// ── Round 32 #F7: nested .gitignore precedence ──────────────────
// parseGitignore used to read only <projectDir>/.gitignore. Patterns
// in nested .gitignore files were silently ignored, so a sub/.gitignore
// declaring `secrets/` did nothing and `tools/grep` happily returned
// hits from that directory. Now the walker collects every .gitignore
// in the tree and rewrites nested patterns with their subdir prefix.

describe("nested .gitignore precedence", () => {
  test("sub/.gitignore patterns scope to that subtree only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "petricode-nested-gi-"));
    try {
      await mkdir(join(dir, "sub"), { recursive: true });
      await mkdir(join(dir, "other"), { recursive: true });
      await writeFile(join(dir, "sub", ".gitignore"), "secret.txt\n");
      const patterns = await parseGitignore(dir);
      const isIgnored = buildIgnorePredicate(patterns);
      expect(isIgnored("sub/secret.txt")).toBe(true);
      expect(isIgnored("other/secret.txt")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("nested negation overrides parent ignore", async () => {
    const dir = await mkdtemp(join(tmpdir(), "petricode-nested-gi-neg-"));
    try {
      await mkdir(join(dir, "sub"), { recursive: true });
      // Parent ignores all *.log; child un-ignores sub/keep.log.
      await writeFile(join(dir, ".gitignore"), "*.log\n");
      await writeFile(join(dir, "sub", ".gitignore"), "!keep.log\n");
      const patterns = await parseGitignore(dir);
      const isIgnored = buildIgnorePredicate(patterns);
      expect(isIgnored("sub/keep.log")).toBe(false);
      expect(isIgnored("sub/drop.log")).toBe(true);
      expect(isIgnored("top.log")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("walker prunes ignored subdirs — does not collect their .gitignore", async () => {
    // Round 33 #1: without pruning, a `dist/.gitignore` would be loaded
    // and its patterns applied even though git itself never looks
    // inside an ignored tree. Worse, the walker pays the FS cost of
    // descending — minutes on big monorepos.
    const dir = await mkdtemp(join(tmpdir(), "petricode-prune-"));
    try {
      await writeFile(join(dir, ".gitignore"), "dist/\n");
      await mkdir(join(dir, "dist"), { recursive: true });
      // A .gitignore inside the ignored dir un-ignoring something
      // would let `dist/keep.txt` slip through if the walker descended.
      await writeFile(join(dir, "dist", ".gitignore"), "!keep.txt\n");
      const patterns = await parseGitignore(dir);
      const isIgnored = buildIgnorePredicate(patterns);
      // dist/ stays ignored; the nested negation never gets loaded.
      expect(isIgnored("dist", true)).toBe(true);
      expect(isIgnored("dist/keep.txt")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("anchored pattern in nested .gitignore stays anchored to its subdir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "petricode-nested-gi-anc-"));
    try {
      await mkdir(join(dir, "sub", "deeper"), { recursive: true });
      // /foo in sub/.gitignore matches sub/foo only, not sub/deeper/foo.
      await writeFile(join(dir, "sub", ".gitignore"), "/foo\n");
      const patterns = await parseGitignore(dir);
      const isIgnored = buildIgnorePredicate(patterns);
      expect(isIgnored("sub/foo")).toBe(true);
      expect(isIgnored("sub/deeper/foo")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── Round 32 #F4: @file ref word boundary ───────────────────────
// FILE_REF_PATTERN used to be /@([^\s]+)/g which matched the
// @domain.com inside email addresses. With a real file named
// `domain.com` in the project, the email got mangled into the file's
// contents. Lookbehind now requires start-of-string or whitespace.

describe("@file refs require leading whitespace", () => {
  test("email@domain.com is not treated as a file reference", async () => {
    const dir = await mkdtemp(join(tmpdir(), "petricode-fileref-email-"));
    try {
      await writeFile(join(dir, "domain.com"), "SECRET");
      const out = await expandFileRefs(
        "contact me at email@domain.com please",
        dir,
      );
      expect(out).not.toContain("SECRET");
      expect(out).toBe("contact me at email@domain.com please");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("@ref at start-of-string still expands", async () => {
    const dir = await mkdtemp(join(tmpdir(), "petricode-fileref-start-"));
    try {
      await writeFile(join(dir, "x.txt"), "HELLO");
      const out = await expandFileRefs("@x.txt is interesting", dir);
      expect(out).toContain("HELLO");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── Round 32 #F3: @file refs skip binary files ──────────────────
// fileRefs.expandFileRefs used to inline any non-FIFO file as UTF-8
// bytes, so `@image.png` dumped 256KB of U+FFFD-mangled garbage into
// the prompt and evicted real context. We now sniff the head for NUL
// bytes and silently skip anything that looks binary.

describe("@file refs skip binary content", () => {
  test("file with NUL byte in head is left as a literal @reference", async () => {
    const dir = await mkdtemp(join(tmpdir(), "petricode-fileref-bin-"));
    try {
      const path = join(dir, "binary.dat");
      // PNG-like header: starts with 0x89 then NUL.
      await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
      const out = await expandFileRefs(`look at @${path}`, dir);
      expect(out).toBe(`look at @${path}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── Round 34 #C2: Composer cursor respects UTF-16 surrogate pairs ─
// Cursor math used `+1`/`-1` and `slice(cursor, cursor+1)` over raw
// JS string indices. Astral chars (most emoji) are 2 code units, so
// the cursor used to land between the high and low surrogate, and
// the next edit sliced the pair apart and rendered U+FFFD. stepLeft
// /stepRight now jump 2 across surrogate boundaries.

describe("Composer cursor stepping over surrogate pairs", () => {
  const emoji = "\uD83C\uDF0E"; // 🌎 — 2 code units

  test("stepRight jumps past a surrogate pair as one unit", () => {
    expect(stepRight(emoji, 0)).toBe(2);
    expect(stepRight(`a${emoji}b`, 1)).toBe(3);
  });

  test("stepLeft jumps back over a surrogate pair as one unit", () => {
    expect(stepLeft(emoji, 2)).toBe(0);
    expect(stepLeft(`a${emoji}b`, 3)).toBe(1);
  });

  test("BMP characters still step by 1", () => {
    expect(stepRight("abc", 1)).toBe(2);
    expect(stepLeft("abc", 2)).toBe(1);
  });

  test("clamps at string boundaries", () => {
    expect(stepLeft("", 0)).toBe(0);
    expect(stepLeft("a", 0)).toBe(0);
    expect(stepRight("a", 1)).toBe(1);
    expect(stepRight("", 0)).toBe(0);
  });

  test("lone surrogate (no pair) steps by 1", () => {
    // Defensive: malformed input shouldn't trap the cursor.
    expect(stepRight("\uD83C", 0)).toBe(1);
    expect(stepLeft("\uDC00", 1)).toBe(0);
  });
});
