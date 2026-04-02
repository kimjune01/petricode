// ── Circuit breaker per tier ────────────────────────────────────
// States: closed (normal), open (failing), half-open (testing)

import type { TierName } from "../config/models.js";

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
  failureThreshold: number;  // consecutive failures to open (default 5)
  cooldownMs: number;        // time before half-open (default 60_000)
}

const DEFAULT_CB_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  cooldownMs: 60_000,
};

// Fallback chain: primary → reviewer → fast → error
const FALLBACK_CHAIN: TierName[] = ["primary", "reviewer", "fast"];

export interface CircuitInfo {
  tier: TierName;
  state: CircuitState;
  failures: number;
  lastFailure: number | null;
}

export class CircuitBreaker {
  private circuits: Map<TierName, {
    state: CircuitState;
    failures: number;
    lastFailure: number | null;
  }> = new Map();

  private config: CircuitBreakerConfig;
  private onStateChange?: (tier: TierName, state: CircuitState) => void;

  constructor(
    config?: Partial<CircuitBreakerConfig>,
    onStateChange?: (tier: TierName, state: CircuitState) => void,
  ) {
    this.config = { ...DEFAULT_CB_CONFIG, ...config };
    this.onStateChange = onStateChange;

    for (const tier of FALLBACK_CHAIN) {
      this.circuits.set(tier, { state: "closed", failures: 0, lastFailure: null });
    }
  }

  /** Check if a tier is available. Transitions open → half-open if cooldown elapsed. */
  isAvailable(tier: TierName, now: number = Date.now()): boolean {
    const circuit = this.circuits.get(tier);
    if (!circuit) return false;

    if (circuit.state === "closed") return true;

    if (circuit.state === "open" && circuit.lastFailure !== null) {
      if (now - circuit.lastFailure >= this.config.cooldownMs) {
        circuit.state = "half-open";
        this.onStateChange?.(tier, "half-open");
        return true;
      }
      return false;
    }

    // half-open: allow one probe
    return circuit.state === "half-open";
  }

  /** Record a successful call. Resets circuit to closed. */
  recordSuccess(tier: TierName): void {
    const circuit = this.circuits.get(tier);
    if (!circuit) return;

    if (circuit.state !== "closed") {
      circuit.state = "closed";
      this.onStateChange?.(tier, "closed");
    }
    circuit.failures = 0;
    circuit.lastFailure = null;
  }

  /** Record a failure. Opens circuit if threshold reached. */
  recordFailure(tier: TierName, now: number = Date.now()): void {
    const circuit = this.circuits.get(tier);
    if (!circuit) return;

    circuit.failures++;
    circuit.lastFailure = now;

    if (circuit.state === "half-open") {
      // Failed during probe — reopen
      circuit.state = "open";
      this.onStateChange?.(tier, "open");
    } else if (circuit.failures >= this.config.failureThreshold) {
      circuit.state = "open";
      this.onStateChange?.(tier, "open");
    }
  }

  /** Get the best available tier, following the fallback chain. Returns null if all open. */
  resolve(preferred: TierName, now: number = Date.now()): TierName | null {
    if (this.isAvailable(preferred, now)) return preferred;

    // Walk fallback chain from preferred onward
    const startIdx = FALLBACK_CHAIN.indexOf(preferred);
    for (let i = startIdx + 1; i < FALLBACK_CHAIN.length; i++) {
      if (this.isAvailable(FALLBACK_CHAIN[i]!, now)) {
        return FALLBACK_CHAIN[i]!;
      }
    }

    return null;
  }

  /** Get circuit info for all tiers (for status display). */
  status(): CircuitInfo[] {
    return FALLBACK_CHAIN.map((tier) => {
      const circuit = this.circuits.get(tier)!;
      return {
        tier,
        state: circuit.state,
        failures: circuit.failures,
        lastFailure: circuit.lastFailure,
      };
    });
  }

  /** Get info for a single tier. */
  getState(tier: TierName): CircuitState {
    return this.circuits.get(tier)?.state ?? "closed";
  }
}
