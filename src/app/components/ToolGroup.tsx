import React, { useState } from "react";
import { Box, Text } from "ink";
import type { ToolCall } from "../../core/types.js";

export default function ToolGroup({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, _setExpanded] = useState(false);
  const hasResult = toolCall.result !== undefined;
  const preview = hasResult
    ? toolCall.result!.slice(0, 80).replace(/\n/g, " ")
    : "pending...";

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text>
        <Text color="yellow">[tool]</Text>{" "}
        <Text bold>{toolCall.name}</Text>
        <Text dimColor> {JSON.stringify(toolCall.args).slice(0, 60)}</Text>
      </Text>
      {expanded && hasResult ? (
        <Box marginLeft={2}>
          <Text dimColor>{toolCall.result}</Text>
        </Box>
      ) : hasResult ? (
        <Box marginLeft={2}>
          <Text dimColor>{preview}...</Text>
        </Box>
      ) : null}
    </Box>
  );
}
