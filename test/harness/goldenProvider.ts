// ── Golden file provider — replays canned StreamChunk sequences ─

import { readFileSync, writeFileSync } from "fs";
import type { Message, StreamChunk } from "../../src/core/types.js";
import type { Provider, ModelConfig } from "../../src/providers/provider.js";

export interface GoldenEnvelope {
  tier: string;
  model: string;
  chunks: StreamChunk[];
}

/**
 * Create a Provider that replays envelopes in order.
 * Each generate() call consumes the next envelope.
 * Throws if more calls than envelopes.
 */
export function createGoldenProvider(envelopes: GoldenEnvelope[]): Provider {
  let callIndex = 0;
  const modelId = envelopes[0]?.model ?? "golden-test";

  return {
    async *generate(
      _prompt: Message[],
      _config: ModelConfig,
    ): AsyncGenerator<StreamChunk> {
      if (callIndex >= envelopes.length) {
        throw new Error(
          `Golden provider exhausted: ${callIndex} calls but only ${envelopes.length} envelopes`,
        );
      }
      const envelope = envelopes[callIndex++]!;
      for (const chunk of envelope.chunks) {
        yield chunk;
      }
    },

    model_id(): string {
      return modelId;
    },

    token_limit(): number {
      return 200_000;
    },

    supports_tools(): boolean {
      return true;
    },
  };
}

/** Load envelopes from a JSONL file (one JSON envelope per line). */
export function loadGoldenFile(path: string): GoldenEnvelope[] {
  const text = readFileSync(path, "utf-8").trim();
  if (!text) return [];
  return text.split("\n").map((line) => JSON.parse(line) as GoldenEnvelope);
}

/** Save envelopes to a JSONL file (one JSON envelope per line). */
export function saveGoldenFile(path: string, envelopes: GoldenEnvelope[]): void {
  const lines = envelopes.map((e) => JSON.stringify(e));
  writeFileSync(path, lines.join("\n") + "\n", "utf-8");
}
