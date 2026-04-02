// ── PipelineRig — headless Pipeline test harness ────────────────

import type { Turn, ToolCall } from "../../src/core/types.js";
import type { TiersConfig } from "../../src/config/models.js";
import type { Provider } from "../../src/providers/provider.js";
import { Pipeline } from "../../src/agent/pipeline.js";
import { TierRouter } from "../../src/providers/router.js";
import { createDefaultRegistry } from "../../src/tools/registry.js";
import { WorkspaceFixture } from "./workspace.js";
import {
  createGoldenProvider,
  type GoldenEnvelope,
} from "./goldenProvider.js";
import type { FileTree } from "./fileTree.js";

export interface PipelineRigOptions {
  projectFiles?: FileTree;
  skills?: FileTree;
  config?: Partial<TiersConfig>;
  /** Golden envelopes for the primary tier. Required for sendTurn. */
  primaryEnvelopes?: GoldenEnvelope[];
  /** Golden envelopes for the reviewer tier. Defaults to empty text response. */
  reviewerEnvelopes?: GoldenEnvelope[];
  /** Golden envelopes for the fast tier. Defaults to empty text response. */
  fastEnvelopes?: GoldenEnvelope[];
}

/** Default envelope that returns a single empty text response. */
function defaultEnvelope(tier: string, model: string): GoldenEnvelope {
  return {
    tier,
    model,
    chunks: [
      { type: "content_delta", text: "ok" },
      { type: "done" },
    ],
  };
}

export class PipelineRig {
  private _pipeline!: Pipeline;
  private _workspace!: WorkspaceFixture;
  private _lastTurn?: Turn;
  private options: PipelineRigOptions;

  constructor(options?: PipelineRigOptions) {
    this.options = options ?? {};
  }

  async init(): Promise<void> {
    // 1. Create workspace
    this._workspace = new WorkspaceFixture("rig");
    await this._workspace.setup({
      projectFiles: this.options.projectFiles,
      skills: this.options.skills,
    });

    // 2. Build golden providers for each tier
    const primaryEnvelopes =
      this.options.primaryEnvelopes ?? [defaultEnvelope("primary", "golden-primary")];
    const reviewerEnvelopes =
      this.options.reviewerEnvelopes ?? [defaultEnvelope("reviewer", "golden-reviewer")];
    const fastEnvelopes =
      this.options.fastEnvelopes ?? [defaultEnvelope("fast", "golden-fast")];

    const primaryProvider = createGoldenProvider(primaryEnvelopes);
    const reviewerProvider = createGoldenProvider(reviewerEnvelopes);
    const fastProvider = createGoldenProvider(fastEnvelopes);

    // 3. Build TierRouter with a factory that returns golden providers
    const providerMap: Record<string, Provider> = {
      "golden-primary": primaryProvider,
      "golden-reviewer": reviewerProvider,
      "golden-fast": fastProvider,
    };

    const tiersConfig: TiersConfig = {
      tiers: {
        primary: { provider: "anthropic", model: "golden-primary" },
        reviewer: { provider: "openai", model: "golden-reviewer" },
        fast: { provider: "anthropic", model: "golden-fast" },
      },
    };

    const router = new TierRouter(tiersConfig, (_providerName, model) => {
      const provider = providerMap[model];
      if (!provider) {
        throw new Error(`No golden provider for model '${model}'`);
      }
      return provider;
    });

    // 4. Build tool registry scoped to workspace
    const registry = createDefaultRegistry();

    // 5. Init pipeline
    this._pipeline = new Pipeline();
    await this._pipeline.init({
      router,
      projectDir: this._workspace.testDir,
      registry,
    });
  }

  async sendTurn(prompt: string): Promise<Turn> {
    this._lastTurn = await this._pipeline.turn(prompt);
    return this._lastTurn;
  }

  /** Tool calls from the last turn. Empty array if none. */
  toolCalls(): ToolCall[] {
    return this._lastTurn?.tool_calls ?? [];
  }

  get pipeline(): Pipeline {
    return this._pipeline;
  }

  get workspace(): WorkspaceFixture {
    return this._workspace;
  }

  async cleanup(): Promise<void> {
    await this._workspace.cleanup();
  }
}
