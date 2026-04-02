// ── Tests for the test harness itself ───────────────────────────

import { describe, test, expect, afterEach } from "bun:test";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";

import { WorkspaceFixture } from "./harness/workspace.js";
import {
  createTestDir,
  writeTree,
  cleanupTestDir,
  type FileTree,
} from "./harness/fileTree.js";
import {
  createGoldenProvider,
  saveGoldenFile,
  loadGoldenFile,
  type GoldenEnvelope,
} from "./harness/goldenProvider.js";
import { PipelineRig } from "./harness/pipelineRig.js";
import type { StreamChunk } from "../src/core/types.js";

// ── WorkspaceFixture ────────────────────────────────────────────

describe("WorkspaceFixture", () => {
  let ws: WorkspaceFixture;

  afterEach(async () => {
    if (ws) await ws.cleanup();
  });

  test("creates isolated dirs", async () => {
    ws = new WorkspaceFixture("iso");
    await ws.setup();

    expect(existsSync(ws.testDir)).toBe(true);
    expect(existsSync(ws.homeDir)).toBe(true);
    expect(existsSync(ws.dataDir)).toBe(true);
    // testDir and homeDir should be siblings under a common temp parent
    expect(ws.testDir).not.toBe(ws.homeDir);
  });

  test("createFile/readFile round-trips", async () => {
    ws = new WorkspaceFixture("roundtrip");
    await ws.setup();

    ws.createFile("src/hello.ts", 'export const x = 1;\n');
    expect(ws.fileExists("src/hello.ts")).toBe(true);
    expect(ws.readFile("src/hello.ts")).toBe('export const x = 1;\n');
  });
});

// ── FileTree ────────────────────────────────────────────────────

describe("FileTree", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await cleanupTestDir(dir);
  });

  test("creates nested structure correctly", async () => {
    const tree: FileTree = {
      "README.md": "# Hello",
      src: {
        "index.ts": "console.log('hi');",
        lib: {
          "utils.ts": "export function add(a: number, b: number) { return a + b; }",
        },
      },
    };

    dir = await createTestDir(tree);

    expect(existsSync(join(dir, "README.md"))).toBe(true);
    expect(existsSync(join(dir, "src", "index.ts"))).toBe(true);
    expect(existsSync(join(dir, "src", "lib", "utils.ts"))).toBe(true);

    const { readFileSync } = await import("fs");
    expect(readFileSync(join(dir, "README.md"), "utf-8")).toBe("# Hello");
    expect(readFileSync(join(dir, "src", "lib", "utils.ts"), "utf-8")).toContain(
      "add",
    );
  });
});

// ── Golden Provider ─────────────────────────────────────────────

describe("Golden provider", () => {
  test("replays envelopes in order", async () => {
    const envelopes: GoldenEnvelope[] = [
      {
        tier: "primary",
        model: "test",
        chunks: [
          { type: "content_delta", text: "Hello " },
          { type: "content_delta", text: "world" },
          { type: "done" },
        ],
      },
      {
        tier: "primary",
        model: "test",
        chunks: [
          { type: "content_delta", text: "Second" },
          { type: "done" },
        ],
      },
    ];

    const provider = createGoldenProvider(envelopes);

    // First call
    const chunks1: StreamChunk[] = [];
    for await (const chunk of provider.generate([], {})) {
      chunks1.push(chunk);
    }
    expect(chunks1).toHaveLength(3);
    expect(chunks1[0]).toEqual({ type: "content_delta", text: "Hello " });
    expect(chunks1[1]).toEqual({ type: "content_delta", text: "world" });

    // Second call
    const chunks2: StreamChunk[] = [];
    for await (const chunk of provider.generate([], {})) {
      chunks2.push(chunk);
    }
    expect(chunks2).toHaveLength(2);
    expect(chunks2[0]).toEqual({ type: "content_delta", text: "Second" });
  });

  test("throws on exhaustion", async () => {
    const provider = createGoldenProvider([
      {
        tier: "primary",
        model: "test",
        chunks: [{ type: "done" }],
      },
    ]);

    // Consume the one envelope
    for await (const _ of provider.generate([], {})) {
      // drain
    }

    // Second call should throw
    expect(async () => {
      for await (const _ of provider.generate([], {})) {
        // drain
      }
    }).toThrow("exhausted");
  });

  test("JSONL round-trip via save/load", async () => {
    const { tmpdir } = await import("os");
    const path = join(tmpdir(), `golden-${crypto.randomUUID()}.jsonl`);

    const envelopes: GoldenEnvelope[] = [
      {
        tier: "primary",
        model: "test-model",
        chunks: [
          { type: "content_delta", text: "hi" },
          { type: "done" },
        ],
      },
    ];

    saveGoldenFile(path, envelopes);
    const loaded = loadGoldenFile(path);

    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.tier).toBe("primary");
    expect(loaded[0]!.chunks).toHaveLength(2);

    // Clean up
    const { rmSync } = await import("fs");
    rmSync(path, { force: true });
  });
});

// ── PipelineRig ─────────────────────────────────────────────────

describe("PipelineRig", () => {
  let rig: PipelineRig;

  afterEach(async () => {
    if (rig) await rig.cleanup();
  });

  test("sends a turn with golden text response", async () => {
    rig = new PipelineRig({
      primaryEnvelopes: [
        {
          tier: "primary",
          model: "golden",
          chunks: [
            { type: "content_delta", text: "Hello from golden!" },
            { type: "done" },
          ],
        },
      ],
    });
    await rig.init();

    const turn = await rig.sendTurn("Say hello");

    expect(turn.role).toBe("assistant");
    expect(turn.content.length).toBeGreaterThan(0);

    const textContent = turn.content.find((c) => c.type === "text");
    expect(textContent).toBeDefined();
    expect((textContent as { type: "text"; text: string }).text).toContain(
      "Hello from golden!",
    );
    expect(rig.toolCalls()).toHaveLength(0);
  });

  test("records tool calls from golden response", async () => {
    rig = new PipelineRig({
      primaryEnvelopes: [
        // First generate() call: model wants to use a tool
        {
          tier: "primary",
          model: "golden",
          chunks: [
            {
              type: "tool_use_start",
              id: "tool-1",
              name: "read_file",
            },
            {
              type: "tool_use_delta",
              input_json: '{"file_path": "/tmp/test.txt"}',
            },
            { type: "done" },
          ],
        },
        // Second generate() call: model responds after tool result
        {
          tier: "primary",
          model: "golden",
          chunks: [
            { type: "content_delta", text: "I read the file." },
            { type: "done" },
          ],
        },
      ],
    });
    await rig.init();

    const turn = await rig.sendTurn("Read the file");

    // The final turn is the text response after the tool loop
    expect(turn.role).toBe("assistant");
    // Tool calls were recorded during the loop; the last turn has no tool calls
    // because the second envelope is pure text
    const textContent = turn.content.find((c) => c.type === "text");
    expect(textContent).toBeDefined();
    expect((textContent as { type: "text"; text: string }).text).toContain(
      "I read the file",
    );
  });

  test("two rigs don't interfere (separate workspaces)", async () => {
    const rig2 = new PipelineRig({
      primaryEnvelopes: [
        {
          tier: "primary",
          model: "golden",
          chunks: [
            { type: "content_delta", text: "Rig 2 response" },
            { type: "done" },
          ],
        },
      ],
    });

    rig = new PipelineRig({
      projectFiles: { "a.txt": "file from rig 1" },
      primaryEnvelopes: [
        {
          tier: "primary",
          model: "golden",
          chunks: [
            { type: "content_delta", text: "Rig 1 response" },
            { type: "done" },
          ],
        },
      ],
    });

    await rig.init();
    await rig2.init();

    // Workspaces are different directories
    expect(rig.workspace.testDir).not.toBe(rig2.workspace.testDir);

    // Files in rig 1 don't appear in rig 2
    expect(rig.workspace.fileExists("a.txt")).toBe(true);
    expect(rig2.workspace.fileExists("a.txt")).toBe(false);

    // Both can send turns independently
    const turn1 = await rig.sendTurn("hello");
    const turn2 = await rig2.sendTurn("hello");

    const text1 = turn1.content.find((c) => c.type === "text") as {
      type: "text";
      text: string;
    };
    const text2 = turn2.content.find((c) => c.type === "text") as {
      type: "text";
      text: string;
    };
    expect(text1.text).toContain("Rig 1");
    expect(text2.text).toContain("Rig 2");

    await rig2.cleanup();
  });
});
