// ── Forward pipe orchestrator ────────────────────────────────────
// Perceive → Cache → Provider → Filter → Tool subpipe → Transmit

import type { Content, Message, Turn, ToolCall, Skill, PerceivedEvent } from "../core/types.js";
import type { FilterSlot, TransmitSlot } from "../core/contracts.js";
import type { Provider, ToolDefinition } from "../providers/provider.js";
import type { TierRouter } from "../providers/router.js";
import type { PolicyRule } from "../filter/policy.js";
import type { ToolRegistry } from "../tools/registry.js";
import { Perceiver, type PerceiverOptions } from "../perceive/perceiver.js";
import { UnionFindCache } from "../cache/cache.js";
import { createFilterChain } from "../filter/filter.js";
import { validateContent } from "../filter/contentValidation.js";
import { LoopDetector } from "../filter/loopDetection.js";
import { assembleTurn } from "./turn.js";
import { assembleContext } from "./context.js";
import {
  runToolSubpipe,
  toolResultsToContent,
  getPartialToolResults,
  type ConfirmFn,
  type ToolResult,
} from "./toolSubpipe.js";
import { loadSkills } from "../skills/loader.js";
import {
  matchSlashCommand,
  matchAutoTriggers,
  substituteArguments,
} from "../skills/activation.js";
import type { ActivatedSkill } from "../skills/types.js";
import { createSkillTool } from "../tools/skill.js";
import { inferProviderFromModel, listKnownModels } from "../config/models.js";

export interface PipelineOptions {
  router: TierRouter;
  projectDir: string;
  sessionId?: string;
  registry?: ToolRegistry;
  policyRules?: PolicyRule[];
  onConfirm?: ConfirmFn;
  maxToolRounds?: number;
}

export class Pipeline {
  private perceiver!: Perceiver;
  private cache!: UnionFindCache;
  private filter!: FilterSlot;
  private transmit?: TransmitSlot;
  private router!: TierRouter;
  private registry?: ToolRegistry;
  private projectDir!: string;
  private policyRules: PolicyRule[] = [];
  private loopDetector!: LoopDetector;
  onConfirm?: ConfirmFn;
  private maxToolRounds: number = 10;
  private _sessionId!: string;
  private skills: Skill[] = [];
  // Serializes turn() invocations. The TUI layer can clear its abortRef
  // synchronously when the user hits Ctrl+C, but the prior pipeline call
  // may still be inside its `finally` draining persistence. Without this,
  // a quick second submit would interleave cache writes with the
  // outgoing tool_result chain.
  private inFlight: Promise<unknown> | null = null;

  async init(options: PipelineOptions): Promise<void> {
    this.projectDir = options.projectDir;
    this.router = options.router;
    this.registry = options.registry;
    this.policyRules = options.policyRules ?? [];
    this.onConfirm = options.onConfirm;
    this.maxToolRounds = options.maxToolRounds ?? 10;
    this._sessionId = options.sessionId ?? crypto.randomUUID();

    // Perceive slot
    this.perceiver = new Perceiver({
      projectDir: options.projectDir,
    });

    // Discover skills, then register the Skill tool so the model can
    // invoke any loaded skill by name. Registered after loading so the
    // tool's name → skill map captures everything that was discovered.
    this.skills = await loadSkills(options.projectDir);
    if (this.registry) {
      this.registry.register(createSkillTool(this.skills));
    }

    // Cache slot
    this.cache = new UnionFindCache();

    // Filter slot — content validation gate
    this.filter = createFilterChain([
      (subject) => validateContent(subject as Turn),
    ]);

    // Loop detector for tool sub-pipe
    this.loopDetector = new LoopDetector();
  }

  /** Attach a TransmitSlot for persistence (optional for headless testing). */
  setTransmit(transmit: TransmitSlot): void {
    this.transmit = transmit;
  }

  /**
   * Run one turn through the full forward pipe.
   *
   * 1. Perceive — expand @-refs, discover context
   * 2. Cache — append user turn, read context window
   * 3. Build prompt, call primary provider
   * 4. Assemble response turn
   * 5. Filter — content validation
   * 6. Tool sub-pipe (loop until no tool calls or max rounds)
   * 7. Cache — append assistant + tool result turns
   * 8. Transmit — persist
   * 9. Return the final assistant turn
   */
  async turn(input: string, options?: { signal?: AbortSignal }): Promise<Turn> {
    // Reject empty/whitespace input at the boundary so headless callers
    // get a clear error rather than an Anthropic 400 about empty text
    // blocks (or a polluted history on lenient providers).
    if (!input || input.trim().length === 0) {
      throw new Error("Pipeline.turn: input is empty");
    }
    // Wait for any prior turn to fully drain (including its finally-block
    // persistence) before starting. Loop, not single-await: when N>2 callers
    // queue on the same prior, they all wake in the same microtask flush
    // and a plain `if` would let them race past the gate together. Re-checking
    // `this.inFlight` after each await ensures the unambiguous successor.
    while (this.inFlight) {
      await this.inFlight.catch(() => {});
    }

    const promise = this._runTurn(input, options);
    // Compare against the wrapped promise — `this.inFlight` holds the
    // wrapped promise, not `promise` itself, so `=== promise` was always
    // false and the cleanup never ran.
    //
    // The trailing `.catch(() => {})` is load-bearing: the caller awaits
    // `promise` and handles errors there. Without swallowing on `wrapped`,
    // a rejection on the original (e.g. provider 429) bubbles to BOTH
    // `promise` (handled by the caller) AND `wrapped` (unhandled, since
    // nobody awaits it) — Node fires unhandledRejection, which cli.ts's
    // crash handler turns into process.exit(1). The TUI dies on the
    // first rate limit instead of recovering to the composer.
    const wrapped: Promise<unknown> = promise
      .finally(() => {
        if (this.inFlight === wrapped) this.inFlight = null;
      })
      .catch(() => {});
    this.inFlight = wrapped;
    return promise;
  }

  private async _runTurn(input: string, options?: { signal?: AbortSignal }): Promise<Turn> {
    const signal = options?.signal;
    // Track all turns produced this invocation so persist covers
    // intermediate tool rounds and abort-interrupted state.
    const pendingPersist: Turn[] = [];

    const commitTurn = (t: Turn) => {
      this.cache.append(t);
      pendingPersist.push(t);
    };

    try {
      return await this._turn(input, signal, commitTurn);
    } finally {
      // Persist everything committed to cache — runs on normal return,
      // break, AND throw (including AbortError). Errors here must NOT
      // override the protected block's outcome (a throw in finally
      // replaces the pending return/throw per ECMAScript semantics),
      // and one failing turn must not block subsequent turns from
      // attempting to persist.
      if (this.transmit && pendingPersist.length > 0) {
        for (const t of pendingPersist) {
          try {
            await this.transmit.append({
              kind: "perceived",
              source: this._sessionId,
              content: t.content,
              timestamp: t.timestamp,
              role: t.role,
            });
          } catch (persistErr) {
            console.error(
              `pipeline: failed to persist turn ${t.id}:`,
              persistErr,
            );
          }
        }
      }
    }
  }

  private async _turn(
    input: string,
    signal: AbortSignal | undefined,
    commitTurn: (t: Turn) => void,
  ): Promise<Turn> {
    // 1. Perceive
    const perceived = await this.perceiver.perceive(input);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (perceived.kind === "retryable") {
      throw new Error(`Perceive failed: ${perceived.message}`);
    }

    // 1b. Skill activation — inject skill body as system context
    const slashMatch = matchSlashCommand(input, this.skills);
    const autoMatches = matchAutoTriggers(input, this.skills);
    const activeSkills: ActivatedSkill[] = [
      ...(slashMatch ? [slashMatch] : []),
      ...autoMatches,
    ];

    const ev = perceived as PerceivedEvent;

    // List manual-trigger skills so the model knows what it can invoke
    // via the Skill tool. Slash and auto skills don't go in the listing —
    // their activation is user-typed (`/foo`) or path-based, not model-
    // initiated. Listing ALL skills would also bloat the system prompt.
    const manualSkills = this.skills.filter((s) => s.trigger === "manual");
    if (manualSkills.length > 0) {
      ev.system_content ??= [];
      const lines = manualSkills.map((s) => {
        const desc = typeof s.frontmatter.description === "string"
          ? s.frontmatter.description
          : "";
        return desc ? `- ${s.name}: ${desc}` : `- ${s.name}`;
      });
      ev.system_content.push({
        type: "text",
        text: `<available_skills>\nUse the Skill tool with one of these names to load its instructions.\n${lines.join("\n")}\n</available_skills>`,
      });
    }

    if (activeSkills.length > 0) {
      ev.system_content ??= [];
      for (const active of activeSkills) {
        const body = substituteArguments(active.skill.body, active.arguments);
        // Skill bodies are trusted — route via system_content so they
        // can't be confused with user-supplied text.
        ev.system_content.push({
          type: "text",
          text: `<skill name="${active.skill.name}">${body}</skill>`,
        });
      }
    }

    // 2. Build context from perceived event + cache history
    //    Split context into system-only (reusable in tool loop) and user message
    const allContextMessages = assembleContext(perceived as PerceivedEvent);
    const systemMessages = allContextMessages.filter(m => m.role === "system");
    const userMessages = allContextMessages.filter(m => m.role !== "system");
    const cachedTurns = this.cache.read();
    const conversation = [...systemMessages, ...cachedTurns.map(t => ({ role: t.role, content: t.content })), ...userMessages];

    // Build the user turn for later cache/persist. perceived.content
    // already excludes context/skill blocks (they live in system_content),
    // so no prefix filtering is needed.
    const userTurn: Turn = {
      id: crypto.randomUUID(),
      role: "user",
      content: (perceived as PerceivedEvent).content.filter((c) => c.type === "text"),
      timestamp: Date.now(),
    };

    // 3. Call primary provider
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const primary = this.router.get("primary");
    const toolDefs = this.registry ? this.toolDefinitions() : undefined;
    const stream = primary.generate(conversation, {
      tools: toolDefs,
      signal,
    });

    // 4. Assemble response
    let assistantTurn: Turn;
    try {
      assistantTurn = await assembleTurn(stream, signal);
    } catch (err) {
      // Cache the user turn on ANY error (abort, rate limit, network)
      // so the user's prompt isn't lost from conversation history.
      commitTurn(userTurn);
      throw err;
    }

    // 4b. Append user turn to cache AFTER model responds, so it's available
    //     for future turns' history but wasn't duplicated in THIS turn's prompt.
    commitTurn(userTurn);

    // 4c. Abort check — if the signal fired while we were streaming,
    //     persist the assistant turn (and synthetic results for any
    //     pending tool calls) before throwing.
    if (signal?.aborted) {
      const pendingTools = assistantTurn.tool_calls ?? [];
      if (pendingTools.length > 0) {
        this.commitToolBatch(assistantTurn, [], commitTurn);
      } else {
        commitTurn(assistantTurn);
      }
      throw new DOMException("Aborted", "AbortError");
    }

    // 5. Filter — content validation (skip for tool-use-only turns)
    const hasToolCalls = assistantTurn.tool_calls && assistantTurn.tool_calls.length > 0;
    if (!hasToolCalls) {
      const filterResult = await this.filter.filter(assistantTurn);
      if (!filterResult.pass) {
        assistantTurn = {
          id: assistantTurn.id,
          role: "assistant",
          content: [
            { type: "text", text: `[filtered] ${filterResult.reason}` },
          ],
          timestamp: Date.now(),
        };
        commitTurn(assistantTurn);
        return assistantTurn;
      }
    }

    // 6. Tool sub-pipe — loop until no tool calls
    let currentTurn = assistantTurn;
    for (let round = 0; round < this.maxToolRounds; round++) {
      if (!currentTurn.tool_calls || currentTurn.tool_calls.length === 0) {
        break;
      }

      if (!this.registry) {
        break; // No tools registered, nothing to execute
      }

      // Guard: if this is the last round and we still have tool calls,
      // synthesize error results so the conversation stays structurally valid.
      if (round === this.maxToolRounds - 1) {
        const syntheticResults: Content[] = currentTurn.tool_calls.map(tc => ({
          type: "tool_result" as const,
          tool_use_id: tc.id,
          content: `Error: max tool rounds (${this.maxToolRounds}) exceeded`,
        }));
        commitTurn(currentTurn);
        const syntheticTurn: Turn = {
          id: crypto.randomUUID(),
          role: "user",
          content: syntheticResults,
          timestamp: Date.now(),
        };
        commitTurn(syntheticTurn);
        // Get a final text response from the provider
        const finalConvo: Message[] = [
          ...systemMessages,
          ...this.cache.read().map(t => ({ role: t.role, content: t.content })),
        ];
        currentTurn = await assembleTurn(primary.generate(finalConvo, { signal }), signal);
        // Defensive: the cleanup turn was generated WITHOUT toolDefs,
        // so it shouldn't carry tool_calls — but providers occasionally
        // emit unsolicited ones. Strip them, and ensure non-empty content
        // so downstream prompt assembly (especially OpenAI which rejects
        // empty assistant messages) doesn't choke on the next user submit.
        if (currentTurn.tool_calls && currentTurn.tool_calls.length > 0) {
          currentTurn = { ...currentTurn, tool_calls: undefined };
        }
        if (currentTurn.content.length === 0) {
          currentTurn = {
            ...currentTurn,
            content: [{ type: "text", text: "[max tool rounds reached]" }],
          };
        }
        break;
      }

      // Abort check — persist partial state before throwing so the
      // next turn's conversation includes the LLM's intent + the
      // fact that it was interrupted.
      if (signal?.aborted) {
        this.commitToolBatch(currentTurn, [], commitTurn);
        throw new DOMException("Aborted", "AbortError");
      }

      let toolResults: Awaited<ReturnType<typeof runToolSubpipe>>;
      try {
        toolResults = await runToolSubpipe(currentTurn, {
          registry: this.registry,
          projectDir: this.projectDir,
          policyRules: this.policyRules,
          loopDetector: this.loopDetector,
          onConfirm: this.onConfirm,
          signal,
        });
      } catch (err) {
        // Mid-batch abort: recover real results of tools that finished
        // before Ctrl+C from the thrown AbortError, then commit the
        // batch so the LLM sees actual outcomes for completed tools and
        // "Interrupted" only for the ones that didn't run. Without this,
        // a successful Bash that mutated the filesystem would be cached
        // as "Interrupted" and the next turn would try to redo it.
        if (err instanceof DOMException && err.name === "AbortError") {
          const partial = getPartialToolResults(err) ?? [];
          this.commitToolBatch(currentTurn, partial, commitTurn);
          throw err;
        }
        throw err;
      }

      // Re-check abort after tool execution — a denied confirmation
      // resolves normally (DENY result) rather than throwing, so we must
      // check the signal to prevent a concurrent second turn from
      // corrupting the cache. Use the actual toolResults so completed
      // tools are preserved instead of synthesized as interrupted.
      if (signal?.aborted) {
        this.commitToolBatch(currentTurn, toolResults, commitTurn);
        throw new DOMException("Aborted", "AbortError");
      }

      // Append assistant turn and tool results to cache
      commitTurn(currentTurn);
      const toolResultContent = toolResultsToContent(toolResults);
      const toolResultTurn: Turn = {
        id: crypto.randomUUID(),
        role: "user", // tool results go back as user role
        content: toolResultContent,
        timestamp: Date.now(),
      };
      commitTurn(toolResultTurn);

      // Build updated conversation — system context + cache history only
      // (user turn is already in cache from step 4b, no duplication)
      const updatedCachedTurns = this.cache.read();
      const updatedConversation: Message[] = [
        ...systemMessages,
        ...updatedCachedTurns.map(t => ({ role: t.role, content: t.content })),
      ];
      const nextStream = primary.generate(updatedConversation, {
        tools: toolDefs,
        signal,
      });
      try {
        currentTurn = await assembleTurn(nextStream, signal);
      } catch (err) {
        // If assembleTurn was aborted mid-stream, the previous round's
        // tool results are already cached. Nothing more to persist —
        // the incomplete response is discarded.
        if (err instanceof DOMException && err.name === "AbortError") {
          throw err;
        }
        throw err;
      }

      // Filter the new turn (skip for tool-use-only turns)
      const nextHasTools = currentTurn.tool_calls && currentTurn.tool_calls.length > 0;
      if (!nextHasTools) {
        const nextFilter = await this.filter.filter(currentTurn);
        if (!nextFilter.pass) {
          currentTurn = {
            id: currentTurn.id,
            role: "assistant",
            content: [
              { type: "text", text: `[filtered] ${nextFilter.reason}` },
            ],
            timestamp: Date.now(),
          };
          break;
        }
      }
    }

    // 7. Cache + persist — append final assistant turn
    commitTurn(currentTurn);

    return currentTurn;
  }

  /** Token count from the cache for the status bar. */
  tokenCount(): number {
    return this.cache.token_count();
  }

  /**
   * Compact the conversation cache: graduate hot turns to the cold
   * union-find zone and enforce the cluster cap. Bounded operation —
   * no LLM call, no async work. Returns the compaction result so the
   * caller (e.g. /compact slash command) can report effectiveness
   * without recomputing token_count() on either side.
   */
  compact() {
    return this.cache.compact();
  }

  /**
   * Wipe conversation history so the next turn() starts fresh. /clear
   * in the TUI was previously only resetting React state, leaving the
   * pipeline cache intact — the model kept remembering the "cleared"
   * conversation across subsequent turns.
   *
   * Also resets the loop detector so the LLM can re-issue an identical
   * tool call after a clear without being falsely flagged as looping.
   */
  clear(): void {
    this.cache.clear();
    this.loopDetector.reset();
  }

  /** Current session ID. */
  sessionId(): string {
    return this._sessionId;
  }

  /** Primary model ID for display. */
  modelId(): string {
    return this.router.get("primary").model_id();
  }

  /**
   * Swap the primary tier to a new model. Vendor is inferred from the
   * model name prefix; throws if it can't be inferred or if the new
   * vendor collides with the reviewer tier (router enforces separation).
   */
  setPrimaryModel(modelId: string): { previous: string; current: string } {
    // Validate against the known-models registry first so typos fail in the
    // TUI rather than silently swapping in a bogus model and surfacing only
    // when the next turn 404s from the provider. Reachability (Vertex region
    // entitlement, etc.) is still on the provider side — this just gates
    // names that aren't recognized at all.
    const known = listKnownModels();
    if (!known.includes(modelId)) {
      throw new Error(
        `Unknown model '${modelId}'. Known: ${known.sort().join(", ")}`,
      );
    }
    const vendor = inferProviderFromModel(modelId);
    if (!vendor) {
      throw new Error(
        `Cannot infer vendor for model '${modelId}' — expected prefix claude-/gpt-/o1/o3/gemini-`,
      );
    }
    const previous = this.modelId();
    this.router.setModel("primary", vendor, modelId);
    return { previous, current: modelId };
  }

  /** Loaded skills for command registration. */
  loadedSkills(): Skill[] {
    return this.skills;
  }

  /** Summary of discovered context files and estimated token count. */
  async contextSummary(): Promise<{ fileCount: number; tokenEstimate: number }> {
    return this.perceiver.contextSummary();
  }

  // ── Private ────────────────────────────────────────────────────

  /**
   * Persist an assistant turn and a tool_result turn that combines the
   * actual results of tools that completed (`partialResults`) with
   * synthetic "Interrupted" markers for any of the assistant's
   * tool_calls that aren't represented. Used both when no tools ran
   * (pre-execution abort, partialResults is []) and when some did
   * (mid-batch abort, partialResults carries the survivors).
   *
   * Earlier rev synthesized "Interrupted" for ALL tool_calls regardless
   * of what executed, telling the LLM that file edits or shell commands
   * it had actually run hadn't — corrupting the cached conversation.
   */
  private commitToolBatch(
    turn: Turn,
    partialResults: ToolResult[],
    commitTurn: (t: Turn) => void,
  ): void {
    commitTurn(turn);

    const realById = new Map(partialResults.map(r => [r.toolUseId, r]));
    const content: Content[] = (turn.tool_calls ?? []).map(tc => {
      const real = realById.get(tc.id);
      return {
        type: "tool_result" as const,
        tool_use_id: tc.id,
        content: real?.content ?? "Interrupted by user — tool call was not executed.",
      };
    });

    commitTurn({
      id: crypto.randomUUID(),
      role: "user",
      content,
      timestamp: Date.now(),
    });
  }

  private toolDefinitions(): ToolDefinition[] {
    if (!this.registry) return [];
    return this.registry.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: { type: "object", ...tool.input_schema } as Record<string, unknown>,
    }));
  }

}
