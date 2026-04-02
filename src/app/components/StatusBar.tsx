import React from "react";
import { Box, Text } from "ink";
import type { AppPhase } from "../state.js";

interface StatusBarProps {
  model: string;
  tokenCount: number;
  phase: AppPhase;
}

const PHASE_LABEL: Record<AppPhase, string> = {
  idle: "idle",
  composing: "ready",
  running: "thinking...",
  confirming: "awaiting confirmation",
};

export default function StatusBar({ model, tokenCount, phase }: StatusBarProps) {
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Text dimColor>{model}</Text>
      <Text dimColor>{PHASE_LABEL[phase]}</Text>
      <Text dimColor>tokens: {tokenCount}</Text>
    </Box>
  );
}
