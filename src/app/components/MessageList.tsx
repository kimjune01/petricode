import React from "react";
import { Box, Text } from "ink";
import type { Turn, Content } from "../../core/types.js";
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
        {turn.tool_calls?.map((tc, i) => (
          <ToolGroup key={i} toolCall={tc} />
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

export default function MessageList({ turns }: { turns: Turn[] }) {
  if (turns.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Type a message to get started, or /help for commands.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {turns.map((turn) => (
        <TurnView key={turn.id} turn={turn} />
      ))}
    </Box>
  );
}
