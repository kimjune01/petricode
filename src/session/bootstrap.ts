// ── Session bootstrap ───────────────────────────────────────────
// Generate session, load config, init pipeline in one call.

import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";
import type { TiersConfig, ConfirmMode } from "../config/models.js";
import { DEFAULT_TIERS, validateTiers } from "../config/models.js";
import { TierRouter } from "../providers/router.js";
import { RetryProvider } from "../providers/retry.js";
import { Pipeline, type PipelineOptions } from "../agent/pipeline.js";
import type { PolicyRule } from "../filter/policy.js";
import { createSqliteTransmit } from "../transmit/sqlite.js";
import { createDefaultRegistry } from "../tools/registry.js";
import { resumeSession } from "./resume.js";
import type { ConfirmFn, ClassifiedNotice } from "../agent/toolSubpipe.js";
import type { UnionFindCache } from "../cache/cache.js";
import { createDefaultClassifier } from "../filter/triageClassifier.js";

export interface BootstrapOptions {
  projectDir?: string;
  sessionId?: string;
  resumeSessionId?: string;
  onConfirm?: ConfirmFn;
  onClassified?: ClassifiedNotice;
  /**
   * Set when running headlessly (no human in the loop). Controls how
   * we react to a failed classifier init: TUI users get a warning and
   * keep going (manual confirmation IS the fallback), headless users
   * crash because no-classifier-headless silently auto-executes
   * ASK_USER tools — a fail-open the user explicitly opted out of by
   * enabling the classifier.
   */
  headless?: boolean;
  /**
   * Per-invocation override for the confirm mode. Wins over `mode` in
   * the on-disk config so `--yolo` / `--permissive` flags don't require
   * editing the config file. Undefined ⇒ fall back to config or default.
   */
  mode?: ConfirmMode;
}

export interface BootstrapResult {
  pipeline: Pipeline;
  sessionId: string;
  resumed: boolean;
  mode: ConfirmMode;
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
        // Present but missing 'tiers' is almost certainly a misconfig —
        // surface it so the user doesn't silently get DEFAULT_TIERS.
        console.warn(`petricode: ${path} present but missing 'tiers' key — using defaults.`);
      } catch (err) {
        // A present-but-invalid file is a bug; silently falling through
        // means the user wonders why their model selection is ignored.
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`petricode: failed to parse ${path}: ${msg} — using defaults.`);
      }
    }
  }

  return DEFAULT_TIERS;
}

/**
 * Bootstrap a complete pipeline with all roles wired.
 * Handles config loading, retry wrapping, transmit setup, and optional resume.
 */
export async function bootstrap(opts: BootstrapOptions = {}): Promise<BootstrapResult> {
  const projectDir = opts.projectDir ?? process.cwd();
  const tiersConfig = loadTiersConfig(projectDir);

  // Wrap providers with retry
  const router = new TierRouter(tiersConfig, (providerName, model) => {
    const { AnthropicProvider } = require("../providers/anthropic.js");
    const { OpenAIProvider } = require("../providers/openai.js");
    const { GoogleProvider } = require("../providers/google.js");

    let provider;
    switch (providerName) {
      case "anthropic":
        provider = new AnthropicProvider(model);
        break;
      case "openai":
        provider = new OpenAIProvider(model);
        break;
      case "google":
        // GoogleProvider auto-detects Vertex vs API-key from env. See
        // src/providers/google.ts and src/providers/router.ts for why
        // we no longer pass options through here.
        provider = new GoogleProvider(model);
        break;
      default:
        throw new Error(`Unknown provider '${providerName}'`);
    }

    return new RetryProvider(provider);
  });

  // Set up tool registry
  const registry = createDefaultRegistry();

  // Set up transmit
  const dataDir = join(projectDir, ".petricode", "data");
  const skillsDir = join(projectDir, ".petricode", "skills");
  const transmit = createSqliteTransmit({ dataDir, skillsDir });

  // Session ID
  const sessionId = opts.sessionId ?? opts.resumeSessionId ?? crypto.randomUUID();

  // Init pipeline. Apply mode → policyRules so `mode: "yolo"` actually
  // skips the confirmation prompt instead of being silently ignored.
  // CLI override (opts.mode) wins over disk config so `--yolo` /
  // `--permissive` work without editing petricode.config.json.
  const mode: ConfirmMode = opts.mode ?? tiersConfig.mode ?? "cautious";
  // Permissive: ALLOW anything that's reversible — file edits, writes,
  // reads — but keep `shell` on ASK_USER because shell side effects
  // (network calls, package installs, `rm -rf`) can't be rolled back
  // by `git checkout`. First-match-wins, so the shell rule must
  // precede the wildcard ALLOW.
  const policyRules: PolicyRule[] = mode === "yolo"
    ? [{ tool: "*", outcome: "ALLOW" }]
    : mode === "permissive"
      ? [
          { tool: "shell", outcome: "ASK_USER" },
          { tool: "*", outcome: "ALLOW" },
        ]
      : [];

  // Classifier is opt-in: bare TiersConfig defaults to no classifier so
  // existing users don't suddenly need GCP creds or eat extra latency.
  //
  // Failure handling depends on mode: TUI users degrade gracefully (the
  // y/n prompt IS the safety net); headless users CRASH (without
  // classifier OR human, ASK_USER auto-executes — that's the silent
  // fail-open the user opted out of by enabling the classifier).
  const classifierCfg = tiersConfig.classifier;
  const classifier = classifierCfg?.enabled
    ? await createDefaultClassifier({
        projectDir,
        modelId: classifierCfg.model,
        timeoutMs: classifierCfg.timeout_ms,
      }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        // Default to headless=true so a future caller that forgets the
        // flag fails CLOSED instead of silently auto-executing.
        // cli.ts (TUI) explicitly opts into headless=false to get
        // graceful degradation to manual confirmation.
        const isHeadless = opts.headless ?? true;
        if (isHeadless) {
          throw new Error(
            `Classifier was enabled in config but failed to initialize: ${msg}. `
              + `In headless mode this would silently auto-execute confirm-required tools — refusing. `
              + `Either fix the issue or set classifier.enabled = false to disable.`,
          );
        }
        // TUI: warn and proceed without classifier. The user can still
        // confirm each ASK_USER tool manually.
        console.warn(
          `petricode: classifier disabled — ${msg}. Falling back to manual confirmation.`,
        );
        return undefined;
      })
    : undefined;

  const pipelineOpts: PipelineOptions = {
    router,
    projectDir,
    sessionId,
    registry,
    policyRules,
    onConfirm: opts.onConfirm,
    classifier,
    onClassified: opts.onClassified,
  };

  const pipeline = new Pipeline();
  await pipeline.init(pipelineOpts);
  pipeline.setTransmit(transmit);

  // Resume if requested
  let resumed = false;
  if (opts.resumeSessionId) {
    const cache = (pipeline as unknown as { cache: UnionFindCache }).cache;
    if (cache) {
      await resumeSession(opts.resumeSessionId, transmit, cache);
      resumed = true;
    }
  }

  return { pipeline, sessionId, resumed, mode };
}
