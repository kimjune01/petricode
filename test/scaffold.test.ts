import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { loadConfig } from "../src/config.js";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("scaffold", () => {
  test("--help exits 0 and prints usage", () => {
    const result = spawnSync("bun", ["run", "src/cli.ts", "--help"], {
      cwd: import.meta.dir + "/..",
      timeout: 5000,
    });
    expect(result.status).toBe(0);
    const out = result.stdout.toString();
    expect(out).toContain("petricode");
    expect(out).toContain("--help");
  });

  test("--version exits 0", () => {
    const result = spawnSync("bun", ["run", "src/cli.ts", "--version"], {
      cwd: import.meta.dir + "/..",
      timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toContain("0.1.0");
  });
});

describe("config loader", () => {
  test("returns empty object when no config files exist", () => {
    const config = loadConfig("/tmp/petricode-test-nonexistent");
    expect(config).toEqual({});
  });

  test("project config overrides global config keys", () => {
    const dir = join(tmpdir(), "petricode-test-" + Date.now());
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "petricode.config.json"),
      JSON.stringify({ model: "local-override" })
    );
    const config = loadConfig(dir);
    expect(config.model).toBe("local-override");
    rmSync(dir, { recursive: true });
  });
});
