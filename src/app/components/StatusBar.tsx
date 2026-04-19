import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { AppPhase } from "../state.js";
import type { ConfirmMode } from "../../config/models.js";
import { colors, spacing } from "../theme.js";
import { useSpinner } from "../spinner.js";

interface StatusBarProps {
  model: string;
  tokenCount: number;
  phase: AppPhase;
  contextSummary?: string;
  // Surface non-default modes loudly so a user who started with --yolo
  // can see the gates are off. Cautious is the default and stays
  // unlabeled to keep the bar uncluttered for the common case.
  mode?: ConfirmMode;
}

const PHASE_LABEL: Record<AppPhase, string> = {
  composing: "ready",
  running: "thinking",
  confirming: "awaiting confirmation",
};

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

// "confirming" intentionally has no hint here — ToolConfirmation
// renders its own keybind line that knows about the optional `m`
// (move-to-trash alternative) binding. A static `y allow / n deny`
// hint here was always wrong when an alternative was offered, and
// the user might press `y` thinking those were the only choices.
const PHASE_HINTS: Record<AppPhase, string | null> = {
  composing: "^C clear  ^C^C quit  ^U kill line  ^W del word",
  running: "^C interrupt",
  confirming: null,
};

export default function StatusBar({ model, tokenCount, phase, contextSummary, mode }: StatusBarProps) {
  const spinner = useSpinner(phase === "running");
  const elapsed = useElapsed(phase === "running");
  const phaseText = phase === "running"
    ? `${spinner} ${PHASE_LABEL[phase]} ${formatElapsed(elapsed)}`
    : PHASE_LABEL[phase];
  const hint = PHASE_HINTS[phase];
  const modeBadge = mode === "yolo"
    ? <Text bold color="red">YOLO</Text>
    : mode === "permissive"
      ? <Text bold color="yellow">PERMISSIVE</Text>
      : null;

  return (
    <Box flexDirection="column">
      {contextSummary && (
        <Text dimColor>{contextSummary}</Text>
      )}
      <Box borderStyle="single" borderColor={colors.muted} paddingX={spacing.sm} justifyContent="space-between">
        <Text color={colors.muted}>{model}</Text>
        <Text>{phaseText}</Text>
        <Box>
          {modeBadge ? <>{modeBadge}<Text color={colors.muted}>  </Text></> : null}
          <Text color={colors.muted}>tokens: {tokenCount}</Text>
        </Box>
      </Box>
      {hint ? <Box marginLeft={spacing.sm}><Text color={colors.muted}>{hint}</Text></Box> : null}
    </Box>
  );
}
