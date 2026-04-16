import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { ToolCall } from "../../core/types.js";
import { colors, spacing } from "../theme.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export default function ToolGroup({ toolCall }: { toolCall: ToolCall }) {
  const hasResult = toolCall.result !== undefined;
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (hasResult) return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 80);
    return () => clearInterval(timer);
  }, [hasResult]);

  const preview = hasResult
    ? toolCall.result!.slice(0, 80).replace(/\n/g, " ")
    : `${SPINNER[frame]} running…`;

  return (
    <Box flexDirection="column" marginLeft={spacing.md}>
      <Text>
        <Text color={colors.tool}>[tool]</Text>{" "}
        <Text bold>{toolCall.name}</Text>
        <Text dimColor> {JSON.stringify(toolCall.args).slice(0, 60)}</Text>
      </Text>
      <Box marginLeft={spacing.md}>
        {hasResult
          ? <Text dimColor>{preview}</Text>
          : <Text color={colors.tool}>{preview}</Text>
        }
      </Box>
    </Box>
  );
}
