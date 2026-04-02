import type { Provider } from "./provider.js";
import type { TierName, TiersConfig } from "../config/models.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";

export type ProviderFactory = (providerName: string, model: string) => Provider;

const ALL_TIERS: TierName[] = ["primary", "reviewer", "fast"];

function defaultFactory(providerName: string, model: string): Provider {
  switch (providerName) {
    case "anthropic":
      return new AnthropicProvider(model);
    case "openai":
      return new OpenAIProvider(model);
    default:
      throw new Error(`Unknown provider '${providerName}'`);
  }
}

export class TierRouter {
  private providers: Map<TierName, Provider> = new Map();

  constructor(config: TiersConfig, factory: ProviderFactory = defaultFactory) {
    for (const tier of ALL_TIERS) {
      const tc = config.tiers[tier];
      if (!tc) {
        throw new Error(`Tier '${tier}' is unwired — startup aborted`);
      }

      this.providers.set(tier, factory(tc.provider, tc.model));
    }

    // Validate: primary and reviewer must be different vendors
    const primaryVendor = config.tiers.primary.provider;
    const reviewerVendor = config.tiers.reviewer.provider;
    if (primaryVendor === reviewerVendor) {
      throw new Error(
        `Primary and reviewer must use different vendors (both are '${primaryVendor}')`,
      );
    }
  }

  get(tier: TierName): Provider {
    const provider = this.providers.get(tier);
    if (!provider) {
      throw new Error(`Tier '${tier}' not found`);
    }
    return provider;
  }
}
