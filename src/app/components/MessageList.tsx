import React from "react";
import { Box, Text } from "ink";
import type { Turn, Content } from "../../core/types.js";
import ToolGroup from "./ToolGroup.js";

function contentToText(content: Content[]): string {
  return content
    .filter((c): c is Extract<Content, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("");
}

function TurnView({ turn }: { turn: Turn }) {
  const text = contentToText(turn.content);

  if (turn.role === "user") {
    return (
      <Box marginBottom={1}>
        <Text bold color="cyan">
          {">"}{" "}
        </Text>
        <Text>{text}</Text>
      </Box>
    );
  }

  if (turn.role === "assistant") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        {text ? <Text>{text}</Text> : null}
        {turn.tool_calls?.map((tc, i) => (
          <ToolGroup key={i} toolCall={tc} />
        ))}
      </Box>
    );
  }

  // system
  return (
    <Box marginBottom={1}>
      <Text dimColor>[system] {text}</Text>
    </Box>
  );
}

export default function MessageList({ turns }: { turns: Turn[] }) {
  return (
    <Box flexDirection="column">
      {turns.map((turn) => (
        <TurnView key={turn.id} turn={turn} />
      ))}
    </Box>
  );
}
