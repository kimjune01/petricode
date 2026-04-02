// ── Forward pipe orchestrator ────────────────────────────────────
// Perceive → Cache → Provider → Filter → Tool subpipe → Remember

import type { Content, Message, Turn, Skill, PerceivedEvent } from "../core/types.js";
import type { FilterSlot, RememberSlot } from "../core/contracts.js";
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
  type ConfirmFn,
} from "./toolSubpipe.js";
import { loadSkills } from "../skills/loader.js";
import {
  matchSlashCommand,
  matchAutoTriggers,
  substituteArguments,
} from "../skills/activation.js";
import type { ActivatedSkill } from "../skills/types.js";

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
  private remember?: RememberSlot;
  private router!: TierRouter;
  private registry?: ToolRegistry;
  private policyRules: PolicyRule[] = [];
  private loopDetector!: LoopDetector;
  private onConfirm?: ConfirmFn;
  private maxToolRounds: number = 10;
  private _sessionId!: string;
  private skills: Skill[] = [];

  async init(options: PipelineOptions): Promise<void> {
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

    // Discover skills
    this.skills = await loadSkills(options.projectDir);

    // Cache slot
    this.cache = new UnionFindCache();

    // Filter slot — content validation gate
    this.filter = createFilterChain([
      (subject) => validateContent(subject as Turn),
    ]);

    // Loop detector for tool sub-pipe
    this.loopDetector = new LoopDetector();
  }

  /** Attach a RememberSlot for persistence (optional for headless testing). */
  setRemember(remember: RememberSlot): void {
    this.remember = remember;
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
   * 8. Remember — persist
   * 9. Return the final assistant turn
   */
  async turn(input: string): Promise<Turn> {
    // 1. Perceive
    const perceived = await this.perceiver.perceive(input);
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

    if (activeSkills.length > 0) {
      for (const active of activeSkills) {
        const body = substituteArguments(active.skill.body, active.arguments);
        // Inject skill body as additional context content (XML format matches context.ts)
        (perceived as PerceivedEvent).content.push({
          type: "text",
          text: `<skill name="${active.skill.name}">${body}</skill>`,
        });
      }
    }

    // 2. Cache — append user turn
    const userTurn: Turn = {
      id: crypto.randomUUID(),
      role: "user",
      content: [{ type: "text", text: input }],
      timestamp: Date.now(),
    };
    this.cache.append(userTurn);

    // Build context from perceived event + cache history
    const contextMessages = assembleContext(perceived as PerceivedEvent);
    const cachedTurns = this.cache.read();
    const conversation = this.buildConversation(contextMessages, cachedTurns);

    // 3. Call primary provider
    const primary = this.router.get("primary");
    const toolDefs = this.registry ? this.toolDefinitions() : undefined;
    const stream = primary.generate(conversation, {
      tools: toolDefs,
    });

    // 4. Assemble response
    let assistantTurn = await assembleTurn(stream);

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
        this.cache.append(assistantTurn);
        await this.persist(userTurn, assistantTurn);
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

      const toolResults = await runToolSubpipe(currentTurn, {
        registry: this.registry,
        policyRules: this.policyRules,
        loopDetector: this.loopDetector,
        onConfirm: this.onConfirm,
      });

      // Append assistant turn and tool results to cache
      this.cache.append(currentTurn);
      const toolResultContent = toolResultsToContent(toolResults);
      const toolResultTurn: Turn = {
        id: crypto.randomUUID(),
        role: "user", // tool results go back as user role
        content: toolResultContent,
        timestamp: Date.now(),
      };
      this.cache.append(toolResultTurn);

      // Build updated conversation and call provider again
      const updatedCachedTurns = this.cache.read();
      const updatedConversation = this.buildConversation(
        contextMessages,
        updatedCachedTurns,
      );
      const nextStream = primary.generate(updatedConversation, {
        tools: toolDefs,
      });
      currentTurn = await assembleTurn(nextStream);

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

    // 7. Cache — append final assistant turn
    this.cache.append(currentTurn);

    // 8. Remember — persist
    await this.persist(userTurn, currentTurn);

    return currentTurn;
  }

  /** Token count from the cache for the status bar. */
  tokenCount(): number {
    return this.cache.token_count();
  }

  /** Current session ID. */
  sessionId(): string {
    return this._sessionId;
  }

  /** Loaded skills for command registration. */
  loadedSkills(): Skill[] {
    return this.skills;
  }

  // ── Private ────────────────────────────────────────────────────

  private buildConversation(
    contextMessages: Message[],
    cachedTurns: Turn[],
  ): Message[] {
    const conversation: Message[] = [];

    // Context messages (system + user from perceiver)
    for (const msg of contextMessages) {
      conversation.push(msg);
    }

    // Cached turns as conversation history
    for (const t of cachedTurns) {
      conversation.push({ role: t.role, content: t.content });
    }

    return conversation;
  }

  private toolDefinitions(): ToolDefinition[] {
    if (!this.registry) return [];
    return this.registry.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    }));
  }

  private async persist(userTurn: Turn, assistantTurn: Turn): Promise<void> {
    if (!this.remember) return;

    // Persist user turn
    await this.remember.append({
      kind: "perceived",
      source: this._sessionId,
      content: userTurn.content,
      timestamp: userTurn.timestamp,
      role: userTurn.role,
    });

    // Persist assistant turn
    await this.remember.append({
      kind: "perceived",
      source: this._sessionId,
      content: assistantTurn.content,
      timestamp: assistantTurn.timestamp,
      role: assistantTurn.role,
    });
  }
}
