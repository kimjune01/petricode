import React from "react";
import { Box, Text, useInput } from "ink";
import type { ToolCall } from "../../core/types.js";

interface ToolConfirmationProps {
  toolCall: ToolCall;
  onConfirm: (allowed: boolean) => void;
}

export default function ToolConfirmation({
  toolCall,
  onConfirm,
}: ToolConfirmationProps) {
  useInput((ch) => {
    if (ch === "y" || ch === "Y") {
      onConfirm(true);
    } else if (ch === "n" || ch === "N") {
      onConfirm(false);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        Tool confirmation required
      </Text>
      <Text>
        <Text bold>{toolCall.name}</Text>
        <Text dimColor> {JSON.stringify(toolCall.args).slice(0, 100)}</Text>
      </Text>
      <Text>
        Allow? <Text bold color="green">[y]</Text>/<Text bold color="red">[n]</Text>
      </Text>
    </Box>
  );
}
