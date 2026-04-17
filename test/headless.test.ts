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
import { parseArgs } from "../src/argv.js";
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

  test("bootstrap rejection becomes exitCode 1 with stderr message (not unhandledRejection)", async () => {
    // Regression backstop for round 20 #1. Previously, a bootstrap throw
    // bubbled past runHeadless to cli.ts's unhandledRejection handler,
    // which wrote a crash log and printed "Crash logged to .petricode/
    // crash.log" — useless for the user. Now the failure is a clean
    // exit-1 with the actual error on stderr.
    //
    // We can't easily make bootstrap throw from a unit test (it touches
    // disk + creates a sqlite DB), so we use module replacement via
    // mock.module to inject a throwing bootstrap.
    const { mock } = await import("bun:test");
    const { runHeadless } = await import("../src/headless.js");
    mock.module("../src/session/bootstrap.js", () => ({
      bootstrap: async () => { throw new Error("bad config"); },
    }));
    const result = await runHeadless({
      prompt: "hi",
      projectDir: "/tmp/petricode-bootstrap-fail",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("bad config");
    mock.restore();
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
    expect(stderr).toContain("requires a prompt string");
  });

  test("`-p --format json` consumes --format as the prompt; `json` is then an unknown positional", async () => {
    // Round-21 trust-the-user behavior + round-22 honesty. `-p` greedily
    // consumes "--format" as its prompt value, leaving "json" as an
    // unrecognized positional that the parser flags. Codifies the
    // tradeoff so a future change either to last-wins or to silent-drop
    // surfaces here.
    const { code, stderr } = await runCli(["-p", "--format", "json"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Unknown flag: json");
    expect(stderr).not.toContain("requires a prompt string");
  });

  test("`--format json` without -p reports misuse (not silent TUI launch)", async () => {
    // Round-21 #2: --format used to be silently dropped if -p was
    // missing, and the CLI happily booted the TUI. Now it errors out.
    const { code, stderr } = await runCli(["--format", "json"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--format requires -p/--prompt");
  });

  test("`--resume -p hi` doesn't consume -p as the session ID", async () => {
    // Pre-fix, args.indexOf("--resume") + 1 returned the index of "-p",
    // which then bootstrap'd a session named "-p" (or 1'd with cryptic
    // error). After fix: --resume sees -p has a leading dash and reports
    // the user-facing error.
    const { code, stderr } = await runCli(["--resume", "-p", "hi"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--resume requires a session ID");
  });

});

// ── parseArgs unit tests ─────────────────────────────────────────
// Direct tests of the argv parser. These replace earlier subprocess+
// timer-killed tests that were prone to false positives on slow CI
// (SIGTERM exit codes trivially passing not-2 checks) and to negative-
// assertion blindspots (any unrelated stderr satisfied the assertion).
// The parser is pure — exercise it as such.

describe("parseArgs", () => {
  test("`--prompt` is an alias for `-p`", () => {
    const a = parseArgs(["--prompt", "hi"]);
    expect(a.prompt).toBe("hi");
    expect(a.errors).toEqual([]);
  });

  test("`-p --format` consumes --format as the prompt value", () => {
    // Round-21 trust-the-user: prompt values may begin with `-`. With
    // no trailing positional after, the parser succeeds cleanly.
    const a = parseArgs(["-p", "--format"]);
    expect(a.prompt).toBe("--format");
    expect(a.formatExplicit).toBe(false);
    expect(a.errors).toEqual([]);
  });

  test("`-p \"--list\"` consumes --list as the prompt, not a top-level flag", () => {
    // Critical UX invariant: --list must not run as the session lister
    // when the user clearly handed it to -p. Pre-fix (indexOf-based
    // parsing) would set both `prompt` and `list`.
    const a = parseArgs(["-p", "--list"]);
    expect(a.prompt).toBe("--list");
    expect(a.list).toBe(false);
  });

  test("`-p \"--help\"` consumes --help as the prompt, not a top-level flag", () => {
    const a = parseArgs(["-p", "--help"]);
    expect(a.prompt).toBe("--help");
    expect(a.help).toBe(false);
  });

  test("`--` ends flag parsing; subsequent tokens are positional and ignored", () => {
    const a = parseArgs(["--", "--list", "--help"]);
    expect(a.list).toBe(false);
    expect(a.help).toBe(false);
    expect(a.errors).toEqual([]);
  });

  test("last -p wins (clig.dev convention)", () => {
    const a = parseArgs(["-p", "first", "-p", "second"]);
    expect(a.prompt).toBe("second");
    expect(a.errors).toEqual([]);
  });

  test("--format text|json sets formatExplicit", () => {
    const a = parseArgs(["-p", "hi", "--format", "json"]);
    expect(a.format).toBe("json");
    expect(a.formatExplicit).toBe(true);
    expect(a.errors).toEqual([]);
  });

  test("--format with bad value reports a parse error", () => {
    const a = parseArgs(["-p", "hi", "--format", "yaml"]);
    expect(a.errors).toContain("--format expects 'text' or 'json'.");
  });

  test("--format without -p is a cross-flag misuse", () => {
    const a = parseArgs(["--format", "json"]);
    expect(a.errors.some((e) => e.includes("--format requires -p/--prompt"))).toBe(true);
  });

  test("--resume rejects a leading-dash next token", () => {
    const a = parseArgs(["--resume", "-p", "hi"]);
    expect(a.errors.some((e) => e.includes("--resume requires a session ID"))).toBe(true);
    expect(a.resume).toBeUndefined();
  });

  test("-p with no value is missing-value misuse", () => {
    const a = parseArgs(["-p"]);
    expect(a.errors.some((e) => e.includes("requires a prompt string"))).toBe(true);
    expect(a.prompt).toBeUndefined();
  });

  test("-p followed by unknown positional reports the positional, not a missing-value", () => {
    const a = parseArgs(["-p", "--format", "json"]);
    expect(a.prompt).toBe("--format");
    expect(a.errors).toContain("Unknown flag: json");
    expect(a.errors.some((e) => e.includes("requires a prompt string"))).toBe(false);
  });
});
