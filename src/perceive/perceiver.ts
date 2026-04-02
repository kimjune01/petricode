import type { PerceiveSlot } from "../core/contracts.js";
import type { PerceivedEvent, RetryableError } from "../core/types.js";
import { expandFileRefs } from "./fileRefs.js";
import { discoverContext } from "./contextDiscovery.js";
import { discoverSkills } from "./skillDiscovery.js";

export interface PerceiverOptions {
  projectDir: string;
  globalConfigDir?: string;
  skillDirs?: string[];
}

export class Perceiver implements PerceiveSlot {
  private projectDir: string;
  private globalConfigDir?: string;
  private skillDirs: string[];

  constructor(opts: PerceiverOptions) {
    this.projectDir = opts.projectDir;
    this.globalConfigDir = opts.globalConfigDir;
    this.skillDirs = opts.skillDirs ?? [];
  }

  /** Return a summary of discovered context files and estimated token count. */
  async contextSummary(): Promise<{ fileCount: number; tokenEstimate: number }> {
    const context = await discoverContext(this.projectDir, this.globalConfigDir);
    const totalChars = context.reduce((sum, f) => sum + f.content.length, 0);
    return { fileCount: context.length, tokenEstimate: Math.ceil(totalChars / 4) };
  }

  async perceive(raw_input: unknown): Promise<PerceivedEvent | RetryableError> {
    const input = String(raw_input);

    try {
      // 1. Expand @file references
      const expanded = await expandFileRefs(input);

      // 2. Discover context fragments
      const context = await discoverContext(this.projectDir, this.globalConfigDir);

      // 3. Discover skills
      const skills = [];
      for (const dir of this.skillDirs) {
        const found = await discoverSkills(dir);
        skills.push(...found);
      }

      // Build content blocks
      const contentParts: Array<{ type: "text"; text: string }> = [
        { type: "text", text: expanded },
      ];

      // Append context as system-level blocks
      for (const frag of context) {
        contentParts.push({
          type: "text",
          text: `<context source="${frag.source}" relevance="${frag.relevance}">\n${frag.content}\n</context>`,
        });
      }

      // Append skill summaries
      for (const skill of skills) {
        contentParts.push({
          type: "text",
          text: `<skill name="${skill.name}" trigger="${skill.trigger}" />`
        });
      }

      return {
        kind: "perceived",
        source: "perceiver",
        content: contentParts,
        timestamp: Date.now(),
      };
    } catch (err) {
      return {
        kind: "retryable",
        message: err instanceof Error ? err.message : String(err),
        retry_after_ms: 1000,
      };
    }
  }
}
