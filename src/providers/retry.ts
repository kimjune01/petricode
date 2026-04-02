// ── Retry wrapper for providers ─────────────────────────────────
// Exponential backoff with jitter. Retries only transient errors.

import type { Content, StreamChunk } from "../core/types.js";
import type { Provider, ModelConfig } from "./provider.js";

const TRANSIENT_CODES = new Set([429, 500, 502, 503, 529]);

export interface RetryConfig {
  maxRetries: number;       // default 3
  baseDelayMs: number;      // default 1000
  maxDelayMs: number;       // default 30000
}

const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

function isTransient(err: unknown): boolean {
  if (err instanceof ProviderError && err.statusCode !== undefined) {
    return TRANSIENT_CODES.has(err.statusCode);
  }
  // Duck-type: many SDK errors expose .status or .statusCode
  const e = err as Record<string, unknown>;
  const code = (e.status ?? e.statusCode) as number | undefined;
  if (typeof code === "number") {
    return TRANSIENT_CODES.has(code);
  }
  return false;
}

function retryAfterFromError(err: unknown): number | undefined {
  if (err instanceof ProviderError) return err.retryAfterMs;
  const e = err as Record<string, unknown>;
  // Some SDKs expose headers
  const headers = e.headers as Record<string, string> | undefined;
  if (headers?.["retry-after"]) {
    const secs = Number(headers["retry-after"]);
    if (!isNaN(secs)) return secs * 1000;
  }
  return undefined;
}

function jitteredDelay(attempt: number, config: RetryConfig): number {
  const exp = config.baseDelayMs * Math.pow(2, attempt);
  const capped = Math.min(exp, config.maxDelayMs);
  // Full jitter: uniform [0, capped]
  return Math.random() * capped;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RetryProvider implements Provider {
  constructor(
    private inner: Provider,
    private config: RetryConfig = DEFAULT_RETRY,
  ) {}

  async *generate(
    prompt: Content[][],
    config: ModelConfig,
  ): AsyncGenerator<StreamChunk> {
    let lastErr: unknown;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const stream = this.inner.generate(prompt, config);
        // Buffer all chunks so a mid-stream failure doesn't yield partial data
        const chunks: StreamChunk[] = [];
        for await (const chunk of stream) {
          chunks.push(chunk);
        }
        for (const chunk of chunks) {
          yield chunk;
        }
        return;
      } catch (err) {
        lastErr = err;

        if (attempt === this.config.maxRetries || !isTransient(err)) {
          throw err;
        }

        const retryAfter = retryAfterFromError(err);
        const delay = retryAfter ?? jitteredDelay(attempt, this.config);
        await sleep(delay);
      }
    }

    throw lastErr;
  }

  model_id(): string {
    return this.inner.model_id();
  }

  token_limit(): number {
    return this.inner.token_limit();
  }

  supports_tools(): boolean {
    return this.inner.supports_tools();
  }
}
