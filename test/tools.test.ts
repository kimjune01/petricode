import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { ReadFileTool } from "../src/tools/readFile.js";
import { WriteFileTool } from "../src/tools/writeFile.js";
import { ShellTool } from "../src/tools/shell.js";
import { GrepTool } from "../src/tools/grep.js";
import { GlobTool } from "../src/tools/glob.js";
import { ToolRegistry, createDefaultRegistry } from "../src/tools/registry.js";

// ── Temp directory ──────────────────────────────────────────────

const TMP = join(tmpdir(), `petricode-tools-test-${Date.now()}`);

beforeAll(() => mkdirSync(TMP, { recursive: true }));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

// ── FileRead ────────────────────────────────────────────────────

describe("FileRead", () => {
  test("reads an existing file", async () => {
    const p = join(TMP, "hello.txt");
    writeFileSync(p, "hello world");
    const result = await ReadFileTool.execute({ path: p });
    expect(result).toBe("hello world");
  });

  test("throws on missing file", async () => {
    await expect(
      ReadFileTool.execute({ path: join(TMP, "nope.txt") })
    ).rejects.toThrow();
  });

  test("throws on missing path arg", async () => {
    await expect(ReadFileTool.execute({})).rejects.toThrow("missing");
  });
});

// ── FileWrite ───────────────────────────────────────────────────

describe("FileWrite", () => {
  test("writes a file and creates parent dirs", async () => {
    const p = join(TMP, "sub", "dir", "out.txt");
    const result = await WriteFileTool.execute({ path: p, content: "data" });
    expect(result).toContain("4 bytes");
    expect(existsSync(p)).toBe(true);
  });

  test("throws on missing content", async () => {
    await expect(
      WriteFileTool.execute({ path: join(TMP, "x.txt") })
    ).rejects.toThrow("missing");
  });
});

// ── Shell ───────────────────────────────────────────────────────

describe("Shell", () => {
  test("runs echo and returns stdout", async () => {
    const result = await ShellTool.execute({ command: "echo hello" });
    expect(result).toBe("hello");
  });

  test("captures stderr on non-zero exit", async () => {
    const result = await ShellTool.execute({ command: "echo err >&2; exit 1" });
    expect(result).toContain("[exit 1]");
    expect(result).toContain("err");
  });

  test("times out on long command", async () => {
    await expect(
      ShellTool.execute({ command: "sleep 10", timeout: 200 })
    ).rejects.toThrow("timed out");
  });
});

// ── Grep ────────────────────────────────────────────────────────

describe("Grep", () => {
  test("finds pattern in file", async () => {
    const p = join(TMP, "search.txt");
    writeFileSync(p, "line one\nline two\nline three\n");
    const result = await GrepTool.execute({ pattern: "two", path: p });
    expect(result).toContain("line two");
  });

  test("returns no matches for absent pattern", async () => {
    const p = join(TMP, "search.txt");
    const result = await GrepTool.execute({ pattern: "zzzzz", path: p });
    expect(result).toBe("(no matches)");
  });

  test("filters by glob", async () => {
    const sub = join(TMP, "grep-glob");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "a.ts"), "export const x = 1;\n");
    writeFileSync(join(sub, "b.js"), "export const x = 1;\n");
    const result = await GrepTool.execute({
      pattern: "export",
      path: sub,
      glob: "*.ts",
    });
    expect(result).toContain("a.ts");
    expect(result).not.toContain("b.js");
  });
});

// ── Glob ────────────────────────────────────────────────────────

describe("Glob", () => {
  test("matches files by pattern", async () => {
    const sub = join(TMP, "glob-test");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "foo.ts"), "");
    writeFileSync(join(sub, "bar.ts"), "");
    writeFileSync(join(sub, "baz.js"), "");
    const result = await GlobTool.execute({ pattern: "*.ts", path: sub });
    expect(result).toContain("foo.ts");
    expect(result).toContain("bar.ts");
    expect(result).not.toContain("baz.js");
  });

  test("returns no matches for unmatched pattern", async () => {
    const result = await GlobTool.execute({ pattern: "*.xyz", path: TMP });
    expect(result).toBe("(no matches)");
  });
});

// ── Registry ────────────────────────────────────────────────────

describe("ToolRegistry", () => {
  test("register, get, list", () => {
    const registry = new ToolRegistry();
    registry.register(ReadFileTool);
    expect(registry.get("file_read")).toBe(ReadFileTool);
    expect(registry.get("nonexistent")).toBeUndefined();
    expect(registry.list()).toHaveLength(1);
  });

  test("execute dispatches to the right tool", async () => {
    const p = join(TMP, "registry-read.txt");
    writeFileSync(p, "registry test");
    const registry = createDefaultRegistry();
    const result = await registry.execute("file_read", { path: p });
    expect(result).toBe("registry test");
  });

  test("execute throws on unknown tool", async () => {
    const registry = new ToolRegistry();
    await expect(
      registry.execute("nope", {})
    ).rejects.toThrow('Unknown tool: "nope"');
  });

  test("execute validates required args", async () => {
    const registry = createDefaultRegistry();
    await expect(
      registry.execute("file_read", {})
    ).rejects.toThrow('missing required argument: "path"');
  });

  test("createDefaultRegistry has all five tools", () => {
    const registry = createDefaultRegistry();
    const names = registry.list().map((t) => t.name).sort();
    expect(names).toEqual(["file_read", "file_write", "glob", "grep", "shell"]);
  });

  test("dispatch tool-call block through registry", async () => {
    const registry = createDefaultRegistry();
    const toolCall = { name: "glob", args: { pattern: "*.ts", path: join(TMP, "glob-test") } };
    const result = await registry.execute(toolCall.name, toolCall.args);
    expect(result).toContain(".ts");
  });
});
