// ── Loop detection (tier 1) ──────────────────────────────────────
// Same tool + same args N times in a row → reject.

import type { FilterResult, ToolCall } from "../core/types.js";

const DEFAULT_THRESHOLD = 5;

export class LoopDetector {
  private history: string[] = [];
  private threshold: number;

  constructor(threshold: number = DEFAULT_THRESHOLD) {
    this.threshold = threshold;
  }

  /**
   * Record a tool call and check for loops.
   * Returns Reject if the same call has appeared `threshold` consecutive times.
   */
  check(call: ToolCall): FilterResult {
    let key: string;
    try {
      key = JSON.stringify({ name: call.name, args: call.args });
    } catch {
      key = `${call.name}:unserializable`;
    }
    this.history.push(key);

    // Count consecutive identical calls from the end
    let count = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i] === key) {
        count++;
      } else {
        break;
      }
    }

    if (count >= this.threshold) {
      return {
        pass: false,
        reason: `Loop detected: ${call.name} called ${count} times with identical args`,
      };
    }
    return { pass: true };
  }

  reset(): void {
    this.history = [];
  }
}
