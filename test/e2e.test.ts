import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Message, StreamChunk, Turn } from "../src/core/types.js";
import type { Provider, ModelConfig } from "../src/providers/provider.js";
import type { TiersConfig } from "../src/config/models.js";
import { TierRouter } from "../src/providers/router.js";
import { Pipeline } from "../src/agent/pipeline.js";
import { RetryProvider, ProviderError } from "../src/providers/retry.js";
import { CircuitBreaker } from "../src/filter/circuitBreaker.js";
import { createSqliteRemember } from "../src/remember/sqlite.js";
import { resumeSession, listSessions } from "../src/session/resume.js";
import { UnionFindCache } from "../src/cache/cache.js";
import { tryCommand } from "../src/commands/index.js";
import { classifyError } from "../src/app/components/ErrorDisplay.js";

// ── Helpers ──────────────────────────────────────────────────────

function makeMockProvider(
  id: string,
  ...calls: StreamChunk[][]
): Provider {
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

function makeTierRouter(
  primaryChunks: StreamChunk[][],
): TierRouter {
  const primary = makeMockProvider("mock-primary", ...primaryChunks);
  const reviewer = makeMockProvider("mock-reviewer", [
    { type: "content_delta" as const, text: "NO_ISSUES" },
    { type: "done" as const },
  ]);
  const fast = makeMockProvider("mock-fast");

  const config: TiersConfig = {
    tiers: {
      primary: { provider: "anthropic", model: "mock-primary" },
      reviewer: { provider: "openai", model: "mock-reviewer" },
      fast: { provider: "anthropic", model: "mock-fast" },
    },
  };

  const providerMap: Record<string, Provider> = {
    "anthropic:mock-primary": primary,
    "openai:mock-reviewer": reviewer,
    "anthropic:mock-fast": fast,
  };

  return new TierRouter(config, (providerName, model) => {
    const key = `${providerName}:${model}`;
    const p = providerMap[key];
    if (!p) throw new Error(`No mock for ${key}`);
    return p;
  });
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "petricode-e2e-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── 1. Retry wrapper ────────────────────────────────────────────

describe("RetryProvider", () => {
  test("retries on 429, succeeds on 2nd attempt", async () => {
    let attempt = 0;
    const inner: Provider = {
      async *generate() {
        attempt++;
        if (attempt === 1) {
          throw new ProviderError("Rate limited", 429);
        }
        yield { type: "content_delta" as const, text: "Success" };
        yield { type: "done" as const };
      },
      model_id: () => "test",
      token_limit: () => 200_000,
      supports_tools: () => true,
    };

    const retried = new RetryProvider(inner, {
      maxRetries: 3,
      baseDelayMs: 1, // fast for test
      maxDelayMs: 10,
    });

    const chunks: StreamChunk[] = [];
    for await (const c of retried.generate([], {})) {
      chunks.push(c);
    }

    expect(attempt).toBe(2);
    expect(chunks).toEqual([
      { type: "content_delta", text: "Success" },
      { type: "done" },
    ]);
  });

  test("does not retry on 401 (non-transient)", async () => {
    let attempt = 0;
    const inner: Provider = {
      async *generate() {
        attempt++;
        throw new ProviderError("Unauthorized", 401);
      },
      model_id: () => "test",
      token_limit: () => 200_000,
      supports_tools: () => true,
    };

    const retried = new RetryProvider(inner, {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 10,
    });

    try {
      for await (const _c of retried.generate([], {})) {
        // consume
      }
      expect(true).toBe(false); // Should not reach
    } catch (err) {
      expect(attempt).toBe(1);
      expect((err as ProviderError).statusCode).toBe(401);
    }
  });

  test("exhausts retries then throws", async () => {
    let attempt = 0;
    const inner: Provider = {
      async *generate() {
        attempt++;
        throw new ProviderError("Server error", 500);
      },
      model_id: () => "test",
      token_limit: () => 200_000,
      supports_tools: () => true,
    };

    const retried = new RetryProvider(inner, {
      maxRetries: 2,
      baseDelayMs: 1,
      maxDelayMs: 10,
    });

    try {
      for await (const _c of retried.generate([], {})) {
        // consume
      }
      expect(true).toBe(false);
    } catch {
      expect(attempt).toBe(3); // 1 initial + 2 retries
    }
  });

  test("delegates model_id, token_limit, supports_tools", () => {
    const inner = makeMockProvider("inner-model");
    const retried = new RetryProvider(inner);
    expect(retried.model_id()).toBe("inner-model");
    expect(retried.token_limit()).toBe(200_000);
    expect(retried.supports_tools()).toBe(true);
  });

  test("yields chunks as they arrive (does not buffer the whole stream)", async () => {
    // Regression: previously the wrapper drained the inner stream into an
    // array before yielding, defeating streaming UX in production. Verify
    // that consumers can observe an early chunk before later ones produce.
    let secondChunkProduced = false;
    const inner: Provider = {
      async *generate() {
        yield { type: "content_delta" as const, text: "first" };
        // Simulate slow second chunk; if RetryProvider is buffering, the
        // consumer wouldn't see "first" until after this resolves.
        await new Promise((r) => setTimeout(r, 30));
        secondChunkProduced = true;
        yield { type: "content_delta" as const, text: "second" };
        yield { type: "done" as const };
      },
      model_id: () => "test",
      token_limit: () => 200_000,
      supports_tools: () => true,
    };

    const retried = new RetryProvider(inner);
    const iter = retried.generate([], {});
    const first = await iter.next();
    expect(first.value).toEqual({ type: "content_delta", text: "first" });
    // Crucially, observed BEFORE the second chunk has even been produced.
    expect(secondChunkProduced).toBe(false);
    // Drain the rest so we don't leak the generator.
    for await (const _c of iter) { /* consume */ }
  });

  test("does not retry once a chunk has been yielded", async () => {
    // Regression: retry must bail if the consumer has already observed a
    // chunk — otherwise the assembleTurn downstream would see duplicate
    // partial output.
    let attempt = 0;
    const inner: Provider = {
      async *generate() {
        attempt++;
        yield { type: "content_delta" as const, text: "partial" };
        throw new ProviderError("Mid-stream failure", 500);
      },
      model_id: () => "test",
      token_limit: () => 200_000,
      supports_tools: () => true,
    };
    const retried = new RetryProvider(inner, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10 });
    const seen: StreamChunk[] = [];
    let threw = false;
    try {
      for await (const c of retried.generate([], {})) seen.push(c);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(attempt).toBe(1); // No retry after partial yield
    expect(seen).toEqual([{ type: "content_delta", text: "partial" }]);
  });

  test("aborts the backoff sleep instead of waiting it out", async () => {
    // Regression: previously sleep() between retries ignored the abort
    // signal, so Ctrl+C during a rate-limit storm could hang for tens of
    // seconds before the next attempt finally noticed the abort.
    let attempt = 0;
    const inner: Provider = {
      async *generate() {
        attempt++;
        throw new ProviderError("rate limited", 429);
      },
      model_id: () => "test",
      token_limit: () => 200_000,
      supports_tools: () => true,
    };
    const retried = new RetryProvider(inner, {
      maxRetries: 3,
      baseDelayMs: 60_000, // huge — would hang the test if not abortable
      maxDelayMs: 60_000,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const start = Date.now();
    let err: unknown;
    try {
      for await (const _ of retried.generate([], { signal: controller.signal })) {
        // no-op
      }
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - start;

    expect(err).toBeDefined();
    expect((err as Error).name).toBe("AbortError");
    expect(elapsed).toBeLessThan(2000);
    // First attempt threw, sleep was aborted before second attempt could run.
    expect(attempt).toBe(1);
  });
});

// ── 2. Circuit breaker ──────────────────────────────────────────

describe("CircuitBreaker", () => {
  test("opens after N failures", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });

    expect(cb.getState("primary")).toBe("closed");

    cb.recordFailure("primary", 1000);
    cb.recordFailure("primary", 2000);
    expect(cb.getState("primary")).toBe("closed");

    cb.recordFailure("primary", 3000);
    expect(cb.getState("primary")).toBe("open");
    expect(cb.isAvailable("primary", 3000)).toBe(false);
  });

  test("transitions to half-open after cooldown", () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 5000 });

    cb.recordFailure("primary", 1000);
    cb.recordFailure("primary", 2000);
    expect(cb.getState("primary")).toBe("open");

    // Before cooldown
    expect(cb.isAvailable("primary", 6000)).toBe(false);

    // After cooldown
    expect(cb.isAvailable("primary", 7001)).toBe(true);
    expect(cb.getState("primary")).toBe("half-open");
  });

  test("resets to closed on success", () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000 });

    cb.recordFailure("primary", 100);
    cb.recordFailure("primary", 200);
    expect(cb.getState("primary")).toBe("open");

    // After cooldown, probe succeeds
    cb.isAvailable("primary", 1300);
    cb.recordSuccess("primary");
    expect(cb.getState("primary")).toBe("closed");
  });

  test("falls back through tier chain", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });

    // Open primary
    cb.recordFailure("primary", 1000);
    expect(cb.resolve("primary", 1000)).toBe("reviewer");

    // Open reviewer too
    cb.recordFailure("reviewer", 1000);
    expect(cb.resolve("primary", 1000)).toBe("fast");

    // Open everything
    cb.recordFailure("fast", 1000);
    expect(cb.resolve("primary", 1000)).toBeNull();
  });

  test("status() returns info for all tiers", () => {
    const cb = new CircuitBreaker();
    const status = cb.status();
    expect(status).toHaveLength(3);
    expect(status.map((s) => s.tier)).toEqual(["primary", "reviewer", "fast"]);
    expect(status.every((s) => s.state === "closed")).toBe(true);
  });

  test("notifies on state changes", () => {
    const changes: string[] = [];
    const cb = new CircuitBreaker(
      { failureThreshold: 1, cooldownMs: 1000 },
      (tier, state) => changes.push(`${tier}:${state}`),
    );

    cb.recordFailure("primary", 100);
    expect(changes).toEqual(["primary:open"]);

    cb.isAvailable("primary", 1200);
    expect(changes).toEqual(["primary:open", "primary:half-open"]);

    cb.recordSuccess("primary");
    expect(changes).toEqual(["primary:open", "primary:half-open", "primary:closed"]);
  });
});

// ── 3. Bootstrap creates working pipeline ───────────────────────

describe("Bootstrap (pipeline init)", () => {
  test("pipeline initializes with project dir and runs a turn", async () => {
    const router = makeTierRouter([
      [
        { type: "content_delta", text: "Hello from bootstrap!" },
        { type: "done" },
      ],
    ]);

    const pipeline = new Pipeline();
    await pipeline.init({
      router,
      projectDir: tmpDir,
    });

    const result = await pipeline.turn("Hi");
    expect(result.role).toBe("assistant");
    expect(result.content[0]!.type).toBe("text");
    expect((result.content[0] as { type: "text"; text: string }).text).toBe(
      "Hello from bootstrap!",
    );
  });

  test("pipeline with remember persists turns", async () => {
    const router = makeTierRouter([
      [{ type: "content_delta", text: "Persisted" }, { type: "done" }],
    ]);

    const dataDir = join(tmpDir, "data");
    const remember = createSqliteRemember({ dataDir });

    const pipeline = new Pipeline();
    await pipeline.init({
      router,
      projectDir: tmpDir,
      sessionId: "persist-test",
    });
    pipeline.setRemember(remember);

    await pipeline.turn("Save this");

    const events = await remember.read("persist-test");
    expect(events.length).toBeGreaterThanOrEqual(1);
  });
});

// ── 4. Session resume ───────────────────────────────────────────

describe("Session resume", () => {
  test("loads persisted turns into cache", async () => {
    const dataDir = join(tmpDir, "data");
    const remember = createSqliteRemember({ dataDir });

    // Seed a session
    const sessionId = "resume-test";
    await remember.append({
      kind: "perceived",
      source: sessionId,
      content: [{ type: "text", text: "Turn one" }],
      timestamp: 1000,
    });
    await remember.append({
      kind: "perceived",
      source: sessionId,
      content: [{ type: "text", text: "Turn two" }],
      timestamp: 2000,
    });

    const cache = new UnionFindCache();
    const result = await resumeSession(sessionId, remember, cache);

    expect(result.sessionId).toBe(sessionId);
    expect(result.turnCount).toBe(2);
    expect(cache.token_count()).toBeGreaterThan(0);

    // Cache should contain the turns
    const reads = cache.read();
    expect(reads.length).toBeGreaterThanOrEqual(2);
  });

  test("throws on nonexistent session", async () => {
    const dataDir = join(tmpDir, "data");
    const remember = createSqliteRemember({ dataDir });
    const cache = new UnionFindCache();

    try {
      await resumeSession("nonexistent", remember, cache);
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toContain("not found");
    }
  });

  test("preserves persisted role across resume", async () => {
    const dataDir = join(tmpDir, "data");
    const remember = createSqliteRemember({ dataDir });
    const sessionId = "resume-role-test";
    await remember.append({
      kind: "perceived",
      source: sessionId,
      content: [{ type: "text", text: "user prompt" }],
      timestamp: 1000,
      role: "user",
    });
    await remember.append({
      kind: "perceived",
      source: sessionId,
      content: [{ type: "text", text: "assistant reply" }],
      timestamp: 2000,
      role: "assistant",
    });

    const cache = new UnionFindCache();
    await resumeSession(sessionId, remember, cache);
    const turns = cache.read();
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
  });

  test("list sessions returns seeded sessions", async () => {
    const dataDir = join(tmpDir, "data");
    const remember = createSqliteRemember({ dataDir });

    await remember.append({
      kind: "perceived",
      source: "sess-1",
      content: [{ type: "text", text: "a" }],
      timestamp: 1000,
    });
    await remember.append({
      kind: "perceived",
      source: "sess-2",
      content: [{ type: "text", text: "b" }],
      timestamp: 2000,
    });

    const sessions = await listSessions(remember, 10);
    expect(sessions.length).toBeGreaterThanOrEqual(2);
  });
});

// ── 5. /help lists all commands ─────────────────────────────────

describe("/help and /clear", () => {
  test("/help lists all commands", () => {
    const result = tryCommand("/help");
    expect(result).not.toBeNull();
    expect(result!.output).toContain("/help");
    expect(result!.output).toContain("/exit");
    expect(result!.output).toContain("/quit");
    expect(result!.output).toContain("/clear");
    expect(result!.output).toContain("/compact");
    expect(result!.output).toContain("/skills");
    expect(result!.output).toContain("@path");
  });

  test("/clear returns cleared message", () => {
    const result = tryCommand("/clear");
    expect(result).not.toBeNull();
    expect(result!.output).toContain("cleared");
    expect(result!.exit).toBeUndefined();
  });

  test("unknown command returns error", () => {
    const result = tryCommand("/nonexistent");
    expect(result).not.toBeNull();
    expect(result!.output).toContain("Unknown command");
  });

  test("non-command returns null", () => {
    const result = tryCommand("just a message");
    expect(result).toBeNull();
  });
});

// ── 6. Error classification ─────────────────────────────────────

describe("ErrorDisplay classification", () => {
  test("classifies rate limit errors", () => {
    const err = classifyError("429 rate limit exceeded");
    expect(err.kind).toBe("provider");
    expect(err.suggestion).toContain("quota");
  });

  test("classifies auth errors", () => {
    const err = classifyError("401 Unauthorized");
    expect(err.kind).toBe("provider");
    expect(err.suggestion).toContain("API key");
  });

  test("classifies network errors", () => {
    const err = classifyError("fetch failed: ECONNRESET");
    expect(err.kind).toBe("network");
    expect(err.suggestion).toContain("internet");
  });

  test("classifies circuit breaker errors", () => {
    const err = classifyError("All tiers are unavailable");
    expect(err.kind).toBe("circuit_open");
  });

  test("classifies unknown errors", () => {
    const err = classifyError("something weird happened");
    expect(err.kind).toBe("unknown");
    expect(err.message).toBe("something weird happened");
  });
});

// ── 7. Default config ───────────────────────────────────────────

describe("Default config", () => {
  test("DEFAULT_TIERS has all three tiers", async () => {
    const { DEFAULT_TIERS } = await import("../src/config/defaults.js");
    expect(DEFAULT_TIERS.tiers.primary).toBeDefined();
    expect(DEFAULT_TIERS.tiers.reviewer).toBeDefined();
    expect(DEFAULT_TIERS.tiers.fast).toBeDefined();
    // Primary and reviewer use different providers
    expect(DEFAULT_TIERS.tiers.primary.provider).not.toBe(
      DEFAULT_TIERS.tiers.reviewer.provider,
    );
  });
});
