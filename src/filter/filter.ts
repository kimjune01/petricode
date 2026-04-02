// ── Filter chain ─────────────────────────────────────────────────
// Compose predicate gates. First rejection stops.

import type { FilterResult } from "../core/types.js";
import type { FilterSlot } from "../core/contracts.js";

export type FilterGate = (subject: unknown) => FilterResult | Promise<FilterResult>;

/**
 * Chain multiple filter gates. Runs sequentially; first rejection stops.
 */
export function createFilterChain(gates: FilterGate[]): FilterSlot {
  return {
    async filter(subject: unknown): Promise<FilterResult> {
      for (const gate of gates) {
        const result = await gate(subject);
        if (!result.pass) return result;
      }
      return { pass: true };
    },
  };
}
