import type { ShareEvent } from "./events.js";

export interface ANSIState {
  streaming: boolean;
}

const BLUE = "\x1b[1;34m";
const PURPLE = "\x1b[1;35m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[90m";
const RESET = "\x1b[0m";

export function serializeANSI(event: ShareEvent, state: ANSIState): string {
  switch (event.type) {
    case "message.user": {
      const actor = event.actor === "host" ? "you" : event.actor;
      const text = (event.payload as { text: string }).text;
      return `${BLUE}${actor}${RESET} › ${text}\n\n`;
    }

    case "message.queued": {
      const text = (event.payload as { text: string }).text;
      return `${YELLOW}${event.actor} (queued)${RESET} › ${text}\n\n`;
    }

    case "message.assistant": {
      if (state.streaming) {
        state.streaming = false;
        return "\n\n";
      }
      const text = (event.payload as { text: string }).text;
      return `${PURPLE}agent${RESET} › ${text}\n\n`;
    }

    case "message.chunk": {
      const text = (event.payload as { text: string }).text;
      if (!state.streaming) {
        state.streaming = true;
        return `${PURPLE}agent${RESET} › ${text}`;
      }
      return text;
    }

    case "tool.request": {
      const name = (event.payload as { name: string }).name;
      const args = JSON.stringify(
        (event.payload as { args?: unknown }).args ?? {},
      ).slice(0, 100);
      return `${DIM}⚙ ${name}(${args})${RESET}\n`;
    }

    case "tool.result": {
      const result = (
        (event.payload as { result?: string }).result ?? ""
      ).slice(0, 500);
      return `${DIM}→ ${result}${RESET}\n\n`;
    }

    case "turn.complete": {
      if (state.streaming) {
        state.streaming = false;
        return "\n\n";
      }
      return "";
    }

    default:
      return "";
  }
}
