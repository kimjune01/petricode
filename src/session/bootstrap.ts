// ── Session bootstrap ───────────────────────────────────────────
// Generate session, load config, init pipeline in one call.

import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";
import type { TiersConfig } from "../config/models.js";
import { DEFAULT_TIERS, validateTiers } from "../config/models.js";
import { TierRouter } from "../providers/router.js";
import { RetryProvider } from "../providers/retry.js";
import { Pipeline, type PipelineOptions } from "../agent/pipeline.js";
import { createSqliteRemember } from "../remember/sqlite.js";
import { createDefaultRegistry } from "../tools/registry.js";
import { resumeSession } from "./resume.js";
import type { ConfirmFn } from "../agent/toolSubpipe.js";
import type { UnionFindCache } from "../cache/cache.js";

export interface BootstrapOptions {
  projectDir?: string;
  sessionId?: string;
  resumeSessionId?: string;
  onConfirm?: ConfirmFn;
}

export interface BootstrapResult {
  pipeline: Pipeline;
  sessionId: string;
  resumed: boolean;
}

function loadTiersConfig(projectDir: string): TiersConfig {
  // Project config first, then global, then defaults
  const projectPath = join(projectDir, "petricode.config.json");
  const globalPath = join(homedir(), ".config", "petricode", "config.json");

  for (const path of [projectPath, globalPath]) {
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, "utf-8"));
        if (raw.tiers) {
          return validateTiers(raw);
        }
      } catch {
        // Fall through to defaults
      }
    }
  }

  return DEFAULT_TIERS;
}

/**
 * Bootstrap a complete pipeline with all roles wired.
 * Handles config loading, retry wrapping, remember setup, and optional resume.
 */
export async function bootstrap(opts: BootstrapOptions = {}): Promise<BootstrapResult> {
  const projectDir = opts.projectDir ?? process.cwd();
  const tiersConfig = loadTiersConfig(projectDir);

  // Wrap providers with retry
  const router = new TierRouter(tiersConfig, (providerName, model) => {
    const { AnthropicProvider } = require("../providers/anthropic.js");
    const { OpenAIProvider } = require("../providers/openai.js");

    let provider;
    switch (providerName) {
      case "anthropic":
        provider = new AnthropicProvider(model);
        break;
      case "openai":
        provider = new OpenAIProvider(model);
        break;
      default:
        throw new Error(`Unknown provider '${providerName}'`);
    }

    return new RetryProvider(provider);
  });

  // Set up tool registry
  const registry = createDefaultRegistry();

  // Set up remember
  const dataDir = join(projectDir, ".petricode", "data");
  const skillsDir = join(projectDir, ".petricode", "skills");
  const remember = createSqliteRemember({ dataDir, skillsDir });

  // Session ID
  const sessionId = opts.sessionId ?? opts.resumeSessionId ?? crypto.randomUUID();

  // Init pipeline
  const pipelineOpts: PipelineOptions = {
    router,
    projectDir,
    sessionId,
    registry,
    onConfirm: opts.onConfirm,
  };

  const pipeline = new Pipeline();
  await pipeline.init(pipelineOpts);
  pipeline.setRemember(remember);

  // Resume if requested
  let resumed = false;
  if (opts.resumeSessionId) {
    const cache = (pipeline as unknown as { cache: UnionFindCache }).cache;
    if (cache) {
      await resumeSession(opts.resumeSessionId, remember, cache);
      resumed = true;
    }
  }

  return { pipeline, sessionId, resumed };
}
