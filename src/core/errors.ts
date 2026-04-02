export class SlotNotRegisteredError extends Error {
  constructor(slot: string) {
    super(`Slot "${slot}" is not registered. Register it before access.`);
    this.name = "SlotNotRegisteredError";
  }
}
