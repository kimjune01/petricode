// ── Loop detection (tier 1) ──────────────────────────────────────
// Same tool + same args N times in a row → reject.

import type { FilterResult, ToolCall } from "../core/types.js";

const DEFAULT_THRESHOLD = 5;

/** Stable JSON: recursively sort object keys so `{a,b}` and `{b,a}` collide. */
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(",")}}`;
}

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
      // Canonical (key-sorted) JSON so reordered args still hash the same.
      // Models often retry with the same logical args but different JSON
      // key insertion order — without sorting, the loop slips past.
      key = `${call.name}:${canonicalStringify(call.args)}`;
    } catch {
      key = `${call.name}:unserializable`;
    }
    this.history.push(key);

    // Prevent unbounded growth — only need threshold entries to detect loops
    if (this.history.length > this.threshold * 2) {
      this.history = this.history.slice(-this.threshold);
    }

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
