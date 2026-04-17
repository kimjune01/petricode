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
}

/**
 * Splits turns into a Static section (rendered once, written to scrollback,
 * never re-rendered) and a live tail. Without Static, every spinner tick in
 * StatusBar/ToolGroup forces Ink to repaint the entire chat history — for
 * long sessions that's enough screen-rewrite churn to manifest as black
 * flashes. Static caps the dynamic redraw region to the active turn.
 *
 * Promotion rule: while the pipeline is in flight, the last turn may still
 * be mutating (tool results filling in), so it stays dynamic. Once the
 * phase settles back to composing, every turn is committed and the whole
 * list moves into Static.
 */
export default function MessageList({ turns, phase }: MessageListProps) {
  if (turns.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Type a message to get started, or /help for commands.</Text>
      </Box>
    );
  }

  const settled = phase === "composing";
  const staticTurns = settled ? turns : turns.slice(0, -1);
  const liveTurn = settled ? null : turns[turns.length - 1];

  return (
    <>
      <Static items={staticTurns}>
        {(turn) => <TurnView key={turn.id} turn={turn} />}
      </Static>
      {liveTurn && (
        <Box flexDirection="column">
          <TurnView turn={liveTurn} />
        </Box>
      )}
    </>
  );
}
