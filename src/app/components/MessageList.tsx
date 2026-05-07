import React from "react";
import { Box, Static, Text } from "ink";
import type { Turn, Content } from "../../core/types.js";
import type { AppPhase } from "../state.js";
import ToolGroup from "./ToolGroup.js";
import Markdown from "./Markdown.js";
import { colors, spacing } from "../theme.js";

function contentToText(content: Content[]): string {
  return content
    .filter((c): c is Extract<Content, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("");
}

const TurnView = React.memo(function TurnView({ turn }: { turn: Turn }) {
  const text = contentToText(turn.content);

  if (turn.role === "user") {
    return (
      <Box marginBottom={spacing.sm}>
        <Text bold color={colors.user}>
          {">"}{" "}
        </Text>
        <Text>{text}</Text>
      </Box>
    );
  }

  if (turn.role === "assistant") {
    return (
      <Box flexDirection="column" marginBottom={spacing.sm}>
        {text ? (
          <Box>
            <Text bold color={colors.assistant}>◆ </Text>
            <Markdown text={text} />
          </Box>
        ) : null}
        {turn.tool_calls?.map((tc) => (
          <ToolGroup key={tc.id} toolCall={tc} />
        ))}
      </Box>
    );
  }

  // system
  return (
    <Box marginBottom={spacing.sm}>
      <Text dimColor>[system] {text}</Text>
    </Box>
  );
});

interface MessageListProps {
  turns: Turn[];
  phase: AppPhase;
  /**
   * Live assistant text being streamed by the in-flight pipeline.turn,
   * before it lands as a settled Turn. Rendered as a transient
   * assistant block under the dynamic tail; cleared when the pipeline
   * resolves.
   */
  streamingText?: string;
}

/**
 * Splits turns into a Static section (rendered once, written to scrollback,
 * never re-rendered) and a live tail. Without Static, every spinner tick in
 * StatusBar/ToolGroup forces Ink to repaint the entire chat history — for
 * long sessions that's enough screen-rewrite churn to manifest as black
 * flashes. Static caps the dynamic redraw region to the active turn.
 *
 * Invariant: turns are append-only (never mutated post-commit) — every
 * tool result or assistant continuation arrives as a brand-new Turn from
 * the reducers in App.tsx / AttachApp.tsx. That makes it safe to put the
 * entire `turns` array in <Static>: Ink keys items by identity, so each
 * turn is written to scrollback exactly once on first render. Mutating a
 * turn in place would be silently dropped — keep the append-only
 * invariant if you change the reducers.
 *
 * The live streaming-text tail stays outside <Static> so it can repaint
 * as chunks arrive; once the pipeline resolves it is cleared and the
 * settled assistant Turn flows into Static on the next render.
 */
export default function MessageList({ turns, phase, streamingText }: MessageListProps) {
  // `phase` is intentionally unused right now — kept on the signature so
  // callers don't need touching if we reintroduce a phase-gated Static
  // promotion strategy. Reference it to keep the noUnusedParameters lint
  // honest under strict mode.
  void phase;

  if (turns.length === 0 && !streamingText) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Type a message to get started, or /help for commands.</Text>
      </Box>
    );
  }

  return (
    <>
      <Static items={turns}>
        {(turn) => <TurnView key={turn.id} turn={turn} />}
      </Static>
      {streamingText && (
        <Box flexDirection="column" marginBottom={spacing.sm}>
          <Box>
            <Text bold color={colors.assistant}>◆ </Text>
            <Markdown text={streamingText} />
          </Box>
        </Box>
      )}
    </>
  );
}
