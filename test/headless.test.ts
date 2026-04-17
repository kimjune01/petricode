import { describe, test, expect } from "bun:test";
import type { Message, StreamChunk, Turn } from "../src/core/types.js";
import type { Provider, ModelConfig } from "../src/providers/provider.js";
import type { TiersConfig } from "../src/config/models.js";
import { TierRouter } from "../src/providers/router.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { Pipeline } from "../src/agent/pipeline.js";
import {
  formatHeadlessOutput,
  runHeadlessTurn,
  turnText,
} from "../src/headless.js";
import { join } from "path";

// ── Mock router (mirrors test/integration.test.ts) ───────────────

function makeMockProvider(id: string, ...calls: StreamChunk[][]): Provider {
  let callIndex = 0;
  return {
    generate(_prompt: Message[], _config: ModelConfig) {
      const chunks = calls[callIndex++] ?? [
        { type: "content_delta" as const, text: "(exhausted)" },
        { type: "done" as const },
      ];
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    },
    model_id: () => id,
    token_limit: () => 200_000,
    supports_tools: () => true,
  };
}

function makeRouter(primaryChunks: StreamChunk[][]): TierRouter {
  const primary = makeMockProvider("mock-primary", ...primaryChunks);
  const reviewer = makeMockProvider("mock-reviewer", [
    { type: "content_delta", text: "ok" },
    { type: "done" },
  ]);
  const fast = makeMockProvider("mock-fast");
  const config: TiersConfig = {
    tiers: {
      primary: { provider: "anthropic", model: "mock-primary" },
      reviewer: { provider: "openai", model: "mock-reviewer" },
      fast: { provider: "anthropic", model: "mock-fast" },
    },
  };
  const map: Record<string, Provider> = {
    "anthropic:mock-primary": primary,
    "openai:mock-reviewer": reviewer,
    "anthropic:mock-fast": fast,
  };
  return new TierRouter(config, (p, m) => {
    const v = map[`${p}:${m}`];
    if (!v) throw new Error(`No mock for ${p}:${m}`);
    return v;
  });
}

async function makePipeline(
  primaryChunks: StreamChunk[][],
  registry?: ToolRegistry,
): Promise<Pipeline> {
  const pipeline = new Pipeline();
  await pipeline.init({
    router: makeRouter(primaryChunks),
    projectDir: "/tmp/petricode-headless-test",
    registry,
  });
  return pipeline;
}

// ── turnText ─────────────────────────────────────────────────────

describe("turnText", () => {
  test("joins multiple text blocks", () => {
    const turn: Turn = {
      id: "t1",
      role: "assistant",
      content: [
        { type: "text", text: "hello " },
        { type: "text", text: "world" },
      ],
      timestamp: 0,
    };
    expect(turnText(turn)).toBe("hello world");
  });

  test("ignores non-text content blocks", () => {
    const turn: Turn = {
      id: "t1",
      role: "assistant",
      content: [
        { type: "text", text: "before " },
        { type: "tool_use", id: "tu1", name: "x", input: {} },
        { type: "text", text: "after" },
      ],
      timestamp: 0,
    };
    expect(turnText(turn)).toBe("before after");
  });
});

// ── formatHeadlessOutput ─────────────────────────────────────────

describe("formatHeadlessOutput", () => {
  const turn: Turn = {
    id: "t1",
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    timestamp: 1234,
  };

  test("text format ends with exactly one trailing newline", () => {
    expect(formatHeadlessOutput(turn, "text")).toBe("hi\n");
  });

  test("text format does not double-newline if the text already ends in one", () => {
    const t: Turn = { ...turn, content: [{ type: "text", text: "hi\n" }] };
    expect(formatHeadlessOutput(t, "text")).toBe("hi\n");
  });

  test("json format emits the full Turn shape", () => {
    const out = formatHeadlessOutput(turn, "json");
    expect(out.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(out);
    expect(parsed.id).toBe("t1");
    expect(parsed.role).toBe("assistant");
    expect(parsed.content).toEqual([{ type: "text", text: "hi" }]);
  });
});

// ── runHeadlessTurn (end-to-end with mock pipeline) ──────────────

describe("runHeadlessTurn", () => {
  test("happy path: returns assistant text on stdout, exit 0", async () => {
    const pipeline = await makePipeline([
      [
        { type: "content_delta", text: "Hello from headless." },
        { type: "done" },
      ],
    ]);

    const result = await runHeadlessTurn(pipeline, "hi");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Hello from headless.\n");
    expect(result.stderr).toBe("");
  });

  test("json format wraps the turn in JSON", async () => {
    const pipeline = await makePipeline([
      [
        { type: "content_delta", text: "json me" },
        { type: "done" },
      ],
    ]);

    const result = await runHeadlessTurn(pipeline, "hi", "json");

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.role).toBe("assistant");
    expect(parsed.content).toEqual([{ type: "text", text: "json me" }]);
  });

  test("auto-allows tool calls (no onConfirm) and returns the post-tool turn", async () => {
    // Two model calls: round 1 emits a tool_use; round 2 returns plain text
    // after seeing the tool result. Locks in the toolSubpipe.ts:106 contract
    // that absent onConfirm = auto-allow. If someone changes that to
    // auto-deny in headless, this test breaks loudly.
    const registry = new ToolRegistry();
    let executed = false;
    registry.register({
      name: "echo",
      description: "Echo back",
      input_schema: {
        properties: { msg: { type: "string" } },
        required: ["msg"],
      },
      execute: async (args) => {
        executed = true;
        return `echoed: ${(args as Record<string, unknown>).msg}`;
      },
    });

    const pipeline = await makePipeline(
      [
        [
          { type: "tool_use_start", id: "t1", name: "echo" },
          { type: "tool_use_delta", input_json: '{"msg":"hi"}' },
          { type: "done" },
        ],
        [
          { type: "content_delta", text: "Tool said hi." },
          { type: "done" },
        ],
      ],
      registry,
    );

    const result = await runHeadlessTurn(pipeline, "use the tool");

    expect(executed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Tool said hi.\n");
  });

  test("empty prompt rejected with clean stderr, exitCode 1", async () => {
    // Pipeline.turn throws "input is empty" at the boundary so we don't
    // need a real model setup — any pipeline rejects this. Use a stub to
    // keep the test fast and avoid a wasted mock turn.
    const stub = {
      async turn(input: string): Promise<Turn> {
        if (!input || !input.trim()) throw new Error("Pipeline.turn: input is empty");
        throw new Error("unreachable");
      },
    } as unknown as Pipeline;

    const result = await runHeadlessTurn(stub, "   ");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("petricode: Pipeline.turn: input is empty\n");
    // Specifically NOT a stack trace
    expect(result.stderr.includes("at ")).toBe(false);
  });

  test("pipeline error becomes exitCode 1 with stderr message", async () => {
    // Stub a pipeline whose turn() rejects — bypasses the mock provider
    // setup since we don't need to drive a real failure mode for this assertion.
    const stub = {
      async turn(): Promise<Turn> {
        throw new Error("boom");
      },
    } as unknown as Pipeline;

    const result = await runHeadlessTurn(stub, "anything");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("petricode: boom\n");
  });
});

// ── Subprocess: stdout drain on exit ─────────────────────────────

describe("stdout drain on process.exit", () => {
  test("1 MB payload survives to a piped reader without truncation", async () => {
    // Spawns the drain fixture (which mirrors cli.ts's drain pattern)
    // with stdout piped. If process.exit fired before the kernel finished
    // draining the pipe, the captured length would be < SIZE.
    const SIZE = 1024 * 1024;
    const fixturePath = join(import.meta.dir, "fixtures", "drain-fixture.ts");
    const proc = Bun.spawn(["bun", fixturePath, String(SIZE)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout.length).toBe(SIZE);
  }, 10_000);
});

// ── CLI flag-parsing UX (subprocess) ─────────────────────────────
// Drives the actual cli.ts entry to assert the user-visible argv
// behavior: malformed prompts get exit 2 and a fix hint, not a cryptic
// "input is empty" once the pipeline starts. Subprocess is needed
// because cli.ts's flag parsing runs at module load.

const cliPath = join(import.meta.dir, "..", "src", "cli.ts");

async function runCli(argv: string[]): Promise<{ code: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn(["bun", cliPath, ...argv], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PETRICODE_NO_TUI: "1" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

describe("cli -p / --prompt argv parsing", () => {
  test("`-p` with no value exits 2 with usage hint", async () => {
    const { code, stderr } = await runCli(["-p"]);
    expect(code).toBe(2);
    expect(stderr).toContain("requires a non-flag prompt string");
  });

  test("`-p --format json` rejects flag-shaped value (doesn't send --format as prompt)", async () => {
    const { code, stderr } = await runCli(["-p", "--format", "json"]);
    expect(code).toBe(2);
    expect(stderr).toContain("requires a non-flag prompt string");
  });

  test("`--prompt` is recognized when -p is absent", async () => {
    // Negative assertion only: the flag parser must NOT bail out with
    // exit 2 (the misuse code we just tested). Whether bootstrap
    // succeeds depends on env creds we don't want to require here, so
    // we kill the process after a short delay and inspect the exit.
    const proc = Bun.spawn(["bun", cliPath, "--prompt", "hi"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const killed = setTimeout(() => proc.kill("SIGTERM"), 1500);
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    clearTimeout(killed);
    expect(code).not.toBe(2);
    expect(stderr).not.toContain("requires a non-flag prompt string");
  }, 5000);
});
