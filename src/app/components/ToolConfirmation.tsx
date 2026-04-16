import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";
import type { ToolCall } from "../../core/types.js";
import type { ConfirmMode } from "../../config/models.js";
import { colors, spacing } from "../theme.js";

const TIMEOUT_SECONDS = 60;

interface ToolConfirmationProps {
  toolCall: ToolCall;
  onConfirm: (allowed: boolean) => void;
  mode?: ConfirmMode;
}

export default function ToolConfirmation({
  toolCall,
  onConfirm,
  mode = "cautious",
}: ToolConfirmationProps) {
  const [remaining, setRemaining] = useState(TIMEOUT_SECONDS);
  const resolvedRef = useRef(false);

  useInput((ch) => {
    if (resolvedRef.current) return;
    if (ch === "y" || ch === "Y") {
      resolvedRef.current = true;
      onConfirm(true);
    } else if (ch === "n" || ch === "N") {
      resolvedRef.current = true;
      onConfirm(false);
    }
  });

  // Reset timer and resolved flag when a new tool confirmation appears
  useEffect(() => {
    resolvedRef.current = false;
    setRemaining(TIMEOUT_SECONDS);
    const timer = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          clearInterval(timer);
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [toolCall.id]);

  // Auto-resolve on timeout — guarded by resolvedRef to prevent double-fire
  useEffect(() => {
    if (remaining === 0 && !resolvedRef.current) {
      resolvedRef.current = true;
      onConfirm(mode === "yolo");
    }
  }, [remaining, mode, onConfirm]);

  const autoAction = mode === "yolo" ? "auto-allow" : "auto-deny";

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={colors.tool} paddingX={spacing.sm}>
      <Text bold color={colors.tool}>
        Tool confirmation required
      </Text>
      <Text>
        <Text bold>{toolCall.name}</Text>
        <Text dimColor> {JSON.stringify(toolCall.args).slice(0, 100)}</Text>
      </Text>
      <Text>
        Allow? <Text bold color={colors.prompt}>✓ [y] allow</Text> / <Text bold color={colors.tool}>✗ [n] deny</Text>
        <Text color={colors.muted}>  {remaining}s to {autoAction}</Text>
      </Text>
    </Box>
  );
}
