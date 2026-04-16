import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { AppPhase } from "../state.js";
import { colors, spacing } from "../theme.js";

interface StatusBarProps {
  model: string;
  tokenCount: number;
  phase: AppPhase;
  contextSummary?: string;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const PHASE_LABEL: Record<AppPhase, string> = {
  idle: "idle",
  composing: "ready",
  running: "thinking",
  confirming: "awaiting confirmation",
};

function useSpinner(active: boolean): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 80);
    return () => clearInterval(timer);
  }, [active]);
  return active ? SPINNER[frame]! : "";
}

function useElapsed(active: boolean): number {
  const [start, setStart] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (active) {
      const now = Date.now();
      setStart(now);
      setElapsed(0);
      const timer = setInterval(() => setElapsed(Date.now() - now), 1000);
      return () => clearInterval(timer);
    }
    setElapsed(0);
  }, [active]);
  return elapsed;
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

const PHASE_HINTS: Record<AppPhase, string> = {
  idle: "q quit",
  composing: "^C clear  ^C^C quit  ^U kill line  ^W del word",
  running: "^C interrupt",
  confirming: "y allow  n deny",
};

export default function StatusBar({ model, tokenCount, phase, contextSummary }: StatusBarProps) {
  const spinner = useSpinner(phase === "running");
  const elapsed = useElapsed(phase === "running");
  const phaseText = phase === "running"
    ? `${spinner} ${PHASE_LABEL[phase]} ${formatElapsed(elapsed)}`
    : PHASE_LABEL[phase];
  const hint = PHASE_HINTS[phase];

  return (
    <Box flexDirection="column">
      {contextSummary && (
        <Text dimColor>{contextSummary}</Text>
      )}
      <Box borderStyle="single" borderColor={colors.muted} paddingX={spacing.sm} justifyContent="space-between">
        <Text color={colors.muted}>{model}</Text>
        <Text>{phaseText}</Text>
        <Text color={colors.muted}>tokens: {tokenCount}</Text>
      </Box>
      {hint ? <Box marginLeft={spacing.sm}><Text color={colors.muted}>{hint}</Text></Box> : null}
    </Box>
  );
}
