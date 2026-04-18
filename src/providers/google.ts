import { GoogleGenAI } from "@google/genai";
import { execSync } from "child_process";
import type { Content, Message, StreamChunk } from "../core/types.js";
import type { Provider, ModelConfig } from "./provider.js";

// Cache the gcloud lookup so a config with multiple google tiers (e.g.
// reviewer + fast) doesn't fork+exec twice during bootstrap.
let cachedGcloudProject: string | null | undefined;
function detectGcloudProject(): string | undefined {
  if (cachedGcloudProject !== undefined) return cachedGcloudProject ?? undefined;
  try {
    const out = execSync("gcloud config get-value project 2>/dev/null", {
      encoding: "utf-8",
      timeout: 2000,
    }).trim();
    cachedGcloudProject = out.length > 0 ? out : null;
  } catch {
    cachedGcloudProject = null;
  }
  return cachedGcloudProject ?? undefined;
}

const MODEL_TOKEN_LIMITS: Record<string, number> = {
  "gemini-2.5-pro": 1_048_576,
  "gemini-2.5-flash": 1_048_576,
  "gemini-3.1-pro-preview": 1_048_576,
  "gemini-2.0-flash": 1_048_576,
};

const DEFAULT_TOKEN_LIMIT = 1_048_576;

export interface GoogleProviderOptions {
  /** Use Vertex AI instead of Generative Language API. Requires ADC or service account. */
  vertexai?: boolean;
  /** GCP project ID. Required for Vertex AI. */
  project?: string;
  /** GCP region. Defaults to "global". */
  location?: string;
  /** API key for Generative Language API (non-Vertex). */
  apiKey?: string;
}

type GeminiPart = {
  text?: string;
  functionCall?: { id?: string; name: string; args: Record<string, unknown> | undefined };
  functionResponse?: { id?: string; name: string; response: { result: string } };
};

function toGoogleContents(prompt: Message[]): {
  systemInstruction: string | undefined;
  contents: Array<{ role: string; parts: GeminiPart[] }>;
} {
  const systemParts: string[] = [];
  const contents: Array<{ role: string; parts: GeminiPart[] }> = [];

  // Build a map of tool_use_id → function name so tool_results can reference correctly.
  // Gemini's functionResponse requires the function name, not the call ID.
  const idToName = new Map<string, string>();
  for (const msg of prompt) {
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        idToName.set(block.id, block.name);
      }
    }
  }

  for (const msg of prompt) {
    if (msg.role === "system") {
      const text = msg.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("\n");
      if (text) systemParts.push(text);
      continue;
    }

    const parts: GeminiPart[] = [];

    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          parts.push({ text: block.text });
          break;
        case "tool_use":
          parts.push({
            functionCall: {
              id: block.id,
              name: block.name,
              args: block.input as Record<string, unknown> | undefined,
            },
          });
          break;
        case "tool_result":
          parts.push({
            functionResponse: {
              id: block.tool_use_id,
              name: idToName.get(block.tool_use_id) ?? block.tool_use_id,
              response: { result: block.content },
            },
          });
          break;
      }
    }

    if (parts.length > 0) {
      contents.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts,
      });
    }
  }

  return {
    systemInstruction: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    contents,
  };
}

export class GoogleProvider implements Provider {
  private client: GoogleGenAI;
  private model: string;

  constructor(model: string, options: GoogleProviderOptions = {}) {
    this.model = model;

    // Auto-detect Vertex when ADC is available so users with
    // GOOGLE_APPLICATION_CREDENTIALS set don't also have to export
    // GOOGLE_GENAI_USE_VERTEXAI=true. Without this the SDK constructs in
    // Generative Language API mode with no apiKey and emits "API key
    // should be set when using the Gemini API." on every construction.
    //
    // Vertex needs a project. We resolve in order: explicit option →
    // GOOGLE_CLOUD_PROJECT env → `gcloud config get-value project`.
    const explicitVertex = options.vertexai === true
      || process.env.GOOGLE_GENAI_USE_VERTEXAI === "true";
    const apiKey = options.apiKey ?? process.env.GOOGLE_API_KEY;
    const project = options.project
      ?? process.env.GOOGLE_CLOUD_PROJECT
      ?? detectGcloudProject();
    const hasADC = !!process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const useVertex = (explicitVertex || (!apiKey && (hasADC || !!project)))
      && !!project;

    if (useVertex) {
      this.client = new GoogleGenAI({
        vertexai: true,
        project,
        location: options.location ?? process.env.GOOGLE_CLOUD_LOCATION ?? "global",
      });
      return;
    }
    if (apiKey) {
      this.client = new GoogleGenAI({ apiKey });
      return;
    }
    // No usable auth. Construct an empty client so startup still
    // completes — the actual call fails with a clear permission error
    // if/when this tier is ever invoked. Matches prior behavior, which
    // always constructed Google providers even when never called.
    this.client = new GoogleGenAI({});
  }

  async *generate(
    prompt: Message[],
    config: ModelConfig,
  ): AsyncGenerator<StreamChunk> {
    const { systemInstruction, contents } = toGoogleContents(prompt);

    const generateConfig: Record<string, unknown> = {};

    if (config.max_tokens) {
      generateConfig.maxOutputTokens = config.max_tokens;
    }
    if (config.temperature !== undefined) {
      generateConfig.temperature = config.temperature;
    }

    // Build tool declarations for function calling.
    // Use parametersJsonSchema (not parameters) to pass raw JSON Schema directly —
    // Vertex AI rejects lowercase "type": "object" in the legacy parameters field.
    let tools: Array<{ functionDeclarations: Array<{ name: string; description: string; parametersJsonSchema: Record<string, unknown> }> }> | undefined;
    if (config.tools?.length) {
      tools = [{
        functionDeclarations: config.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parametersJsonSchema: t.input_schema,
        })),
      }];
    }

    const response = await this.client.models.generateContentStream({
      model: this.model,
      contents,
      config: {
        ...generateConfig,
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(tools ? { tools } : {}),
        // Cancels the in-flight HTTP request when the user hits Ctrl+C
        // before any chunk arrives. The for-await poll below covers
        // the during-stream case.
        ...(config.signal ? { abortSignal: config.signal } : {}),
      },
    });

    let toolIndex = 0;

    for await (const chunk of response) {
      if (config.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (!chunk.candidates?.[0]?.content?.parts) continue;

      for (const part of chunk.candidates[0].content.parts) {
        // Skip thought/thinking parts — they're internal model reasoning,
        // and Vertex AI has incompatible encryption for thoughtSignature.
        if ((part as Record<string, unknown>).thought) continue;

        if (part.text) {
          yield { type: "content_delta", text: part.text };
        }

        if (part.functionCall) {
          // Preserve Gemini's ID for parallel tool call correlation; generate fallback if absent
          const id = part.functionCall.id ?? `call_${crypto.randomUUID().slice(0, 8)}`;
          const name = part.functionCall.name ?? "unknown";
          yield {
            type: "tool_use_start",
            id,
            name,
            index: toolIndex,
          };
          // Gemini sends function call args as a complete object, not streaming
          yield {
            type: "tool_use_delta",
            input_json: JSON.stringify(part.functionCall.args ?? {}),
            index: toolIndex,
          };
          toolIndex++;
        }
      }
    }

    yield { type: "done" };
  }

  model_id(): string {
    return this.model;
  }

  token_limit(): number {
    return MODEL_TOKEN_LIMITS[this.model] ?? DEFAULT_TOKEN_LIMIT;
  }

  supports_tools(): boolean {
    return true;
  }
}
