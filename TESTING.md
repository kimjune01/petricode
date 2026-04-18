# Testing Guide

Petricode has three levels of verification: tests, sanity checks, and evals. Tests verify contracts. Sanity checks verify the thing works when you plug it in. Evals measure whether it's getting better.

## Tests (no API keys)

```bash
bun test
```

269 tests across 20 files. All use mock providers — no API calls, no cost, fast. Run these after every change.

### What's tested

| Area | File | What it verifies |
|------|------|-----------------|
| Scaffold | `test/scaffold.test.ts` | CLI --help/--version, config loading |
| Contracts | `test/runtime.contract.test.ts` | DI container, all 5 slots registered and callable |
| Providers | `test/providers.test.ts` | Adapter shape, tier resolution, mocked streams |
| Agent loop | `test/agent.loop.test.ts` | Turn assembly, tool detection, loop iteration |
| Tools | `test/tools.test.ts` | Each tool + registry dispatch + schema validation |
| Perceive | `test/perceive.test.ts` | Context discovery, @file refs, skill parsing |
| Transmit | `test/transmit.test.ts` | SQLite round-trip, skills, decisions, blobs |
| Cache | `test/cache.test.ts` | Union-find, LRU eviction, hot/cold zones |
| Filter | `test/filter.test.ts` | Content validation, masking, policy, loop detection |
| Volley | `test/volley.test.ts` | Convergence, round counting, input validation |
| TUI | `test/tui.test.ts` | Slash commands, state init |
| Integration | `test/integration.test.ts` | Context assembly, tool subpipe, full pipeline turns |
| Consolidate | `test/consolidate.test.ts` | Triple extraction, grouping, skill generation |
| E2E | `test/e2e.test.ts` | Bootstrap, retry, circuit breaker, resume, errors |
| Harness | `test/harness.test.ts` | Test infrastructure itself (PipelineRig, golden files) |

### Test harness

The `test/harness/` directory provides structured testing utilities:

```typescript
import { PipelineRig, WorkspaceFixture, createTestDir, createGoldenProvider } from "./harness/index.js";
```

- **PipelineRig** — headless pipeline testing with golden provider responses. Creates isolated workspace, wires all slots, lets you send turns and inspect tool calls.
- **GoldenProvider** — replays canned `StreamChunk` sequences from JSONL envelope files. Deterministic multi-turn testing without API keys.
- **WorkspaceFixture** — isolated `testDir` + `homeDir` per test. Pre-creates `.config/petricode/` structure. No test touches your real config.
- **createTestDir** — declarative temp filesystem: `{ "src/index.ts": "code", "test/": { "foo.test.ts": "..." } }`.

### Writing a new test

```typescript
import { describe, test, expect, afterEach } from "bun:test";
import { PipelineRig } from "./harness/index.js";

describe("my feature", () => {
  let rig: PipelineRig;

  afterEach(async () => {
    if (rig) await rig.cleanup();
  });

  test("does the thing", async () => {
    rig = new PipelineRig({
      goldenResponses: [
        { tier: "primary", model: "test", chunks: [
          { type: "content_delta", text: "Hello" },
          { type: "done" },
        ]},
      ],
    });
    await rig.init();

    const turn = await rig.sendTurn("test prompt");
    expect(turn.content[0]).toEqual({ type: "text", text: "Hello" });
  });
});
```

## Sanity checks (requires API keys)

Tests verify contracts with mocks. Sanity checks verify the real providers, real streaming, real tool execution.

### Setup

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
# Or, for Vertex auth: export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
# (project is resolved from GOOGLE_CLOUD_PROJECT or `gcloud config get-value project`)
```

### One-shot headless turn

```bash
bun run src/cli.ts -p "Read the README.md and tell me what this project is."
```

**What to look for:**
- Model streams a response (not empty, not an error)
- If it calls `file_read`, the tool executes and returns file contents
- The response references actual content from README.md
- No stack traces

### Sticky-session back-and-forth

```bash
bun run src/cli.ts -p "pick a number between 1 and 10" --session-file /tmp/pc
bun run src/cli.ts -p "what number did you pick?"      --session-file /tmp/pc
```

The file at `/tmp/pc` holds the resolved session ID. Delete it to start
fresh; pass the same path to resume. Mutually exclusive with `--resume`.

### Resuming an arbitrary session

```bash
bun run src/cli.ts --list                       # find a session ID
bun run src/cli.ts --resume <id> -p "follow-up" # resume it headless
```

### TUI sanity check

```bash
bun run src/cli.ts
```

- 🧫 logo and status bar appear
- Streaming response, tool confirmations, slash commands all wired
- `q` or `/exit` exits cleanly

## Evals (future)

Not yet implemented. The plan (from `GOAL.md`):

1. Run the same task with different slot implementations, measure outcomes
2. Run Consolidate on N sessions, measure task performance on session N+1 vs session 1
3. Tune union-find parameters (merge threshold, cluster cap), measure token usage and recall

## Typecheck

```bash
bunx tsc --noEmit
```

Run alongside tests. Catches type-level contract violations that tests miss.
