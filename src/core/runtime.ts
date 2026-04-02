import type { SlotMap, SlotName } from "./contracts.js";
import { SlotNotRegisteredError } from "./errors.js";

export class Runtime {
  private slots = new Map<string, unknown>();

  register<K extends SlotName>(name: K, impl: SlotMap[K]): void {
    this.slots.set(name, impl);
  }

  get<K extends SlotName>(name: K): SlotMap[K] {
    const slot = this.slots.get(name);
    if (!slot) {
      throw new SlotNotRegisteredError(name);
    }
    return slot as SlotMap[K];
  }
}
