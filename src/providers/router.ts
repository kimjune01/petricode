import type { Provider } from "./provider.js";
import type { ProviderName, TierName, TiersConfig } from "../config/models.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { GoogleProvider } from "./google.js";

export type ProviderFactory = (providerName: string, model: string) => Provider;

const ALL_TIERS: TierName[] = ["primary", "reviewer", "fast"];

function defaultFactory(providerName: string, model: string): Provider {
  switch (providerName) {
    case "anthropic":
      return new AnthropicProvider(model);
    case "openai":
      return new OpenAIProvider(model);
    case "google":
      // GoogleProvider auto-detects Vertex vs API-key from env (ADC,
      // GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_API_KEY). Pass-through is
      // unnecessary and used to result in `vertexai: false` clobbering
      // the auto-detect path.
      return new GoogleProvider(model);
    default:
      throw new Error(`Unknown provider '${providerName}'`);
  }
}

export class TierRouter {
  private providers: Map<TierName, Provider> = new Map();
  private vendors: Map<TierName, ProviderName> = new Map();
  private factory: ProviderFactory;

  constructor(config: TiersConfig, factory: ProviderFactory = defaultFactory) {
    this.factory = factory;
    for (const tier of ALL_TIERS) {
      const tc = config.tiers[tier];
      if (!tc) {
        throw new Error(`Tier '${tier}' is unwired — startup aborted`);
      }

      this.providers.set(tier, factory(tc.provider, tc.model));
      this.vendors.set(tier, tc.provider);
    }

    this.validateVendorSeparation();
  }

  get(tier: TierName): Provider {
    const provider = this.providers.get(tier);
    if (!provider) {
      throw new Error(`Tier '${tier}' not found`);
    }
    return provider;
  }

  /**
   * Replace the provider for `tier` with a freshly constructed one. Re-runs
   * vendor-separation validation; on failure, the previous binding is restored
   * so partial state can't violate the invariant.
   */
  setModel(tier: TierName, provider: ProviderName, model: string): void {
    const prevProvider = this.providers.get(tier);
    const prevVendor = this.vendors.get(tier);
    const newProvider = this.factory(provider, model);
    this.providers.set(tier, newProvider);
    this.vendors.set(tier, provider);
    try {
      this.validateVendorSeparation();
    } catch (err) {
      if (prevProvider) this.providers.set(tier, prevProvider);
      if (prevVendor) this.vendors.set(tier, prevVendor);
      throw err;
    }
  }

  private validateVendorSeparation(): void {
    const primaryVendor = this.vendors.get("primary");
    const reviewerVendor = this.vendors.get("reviewer");
    if (primaryVendor && primaryVendor === reviewerVendor) {
      throw new Error(
        `Primary and reviewer must use different vendors (both are '${primaryVendor}')`,
      );
    }
  }
}
