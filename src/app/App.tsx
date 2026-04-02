import React, { useState, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { Turn, Content } from "../core/types.js";
import type { AppPhase } from "./state.js";
import { initialState } from "./state.js";
import { tryCommand } from "../commands/index.js";
import MessageList from "./components/MessageList.js";
import Composer from "./components/Composer.js";
import ToolConfirmation from "./components/ToolConfirmation.js";
import StatusBar from "./components/StatusBar.js";
import ReviewerNotes from "./components/ReviewerNotes.js";

export default function App() {
  const { exit } = useApp();
  const [state, setState] = useState(initialState);
  const [reviewerFindings, setReviewerFindings] = useState<string[]>([]);

  useInput((_ch, key) => {
    if (key.ctrl && _ch === "c") {
      exit();
    }
    // Quick quit when composing with empty input
    if (_ch === "q" && state.phase === "idle") {
      exit();
    }
  });

  const addSystemTurn = useCallback((text: string) => {
    const turn: Turn = {
      id: crypto.randomUUID(),
      role: "system",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    };
    setState((prev) => ({ ...prev, turns: [...prev.turns, turn] }));
  }, []);

  const handleSubmit = useCallback(
    (input: string) => {
      // Check for slash commands first
      const cmdResult = tryCommand(input);
      if (cmdResult) {
        addSystemTurn(cmdResult.output);
        if (cmdResult.exit) {
          exit();
        }
        return;
      }

      // Add user turn
      const userTurn: Turn = {
        id: crypto.randomUUID(),
        role: "user",
        content: [{ type: "text", text: input }],
        timestamp: Date.now(),
      };

      setState((prev) => ({
        ...prev,
        phase: "running" as AppPhase,
        turns: [...prev.turns, userTurn],
      }));

      // Placeholder: in a real integration this would call runLoop.
      // For now, echo back that the agent loop is not wired up yet.
      const assistantTurn: Turn = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: [
          {
            type: "text",
            text: `[agent loop not connected] Received: "${input}"`,
          },
        ],
        timestamp: Date.now(),
      };

      setState((prev) => ({
        ...prev,
        phase: "composing" as AppPhase,
        turns: [...prev.turns, assistantTurn],
      }));
    },
    [addSystemTurn, exit],
  );

  const handleToolConfirm = useCallback((allowed: boolean) => {
    if (!state.pendingToolCall) return;
    addSystemTurn(
      allowed
        ? `Allowed: ${state.pendingToolCall.name}`
        : `Denied: ${state.pendingToolCall.name}`,
    );
    setState((prev) => ({
      ...prev,
      phase: "composing" as AppPhase,
      pendingToolCall: null,
    }));
  }, [state.pendingToolCall, addSystemTurn]);

  const isComposing = state.phase === "composing";

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>petricode</Text>
      <Box flexDirection="column" flexGrow={1} marginY={1}>
        <MessageList turns={state.turns} />
        <ReviewerNotes findings={reviewerFindings} />
      </Box>

      {state.error && (
        <Box marginBottom={1}>
          <Text color="red">{state.error}</Text>
        </Box>
      )}

      {state.phase === "confirming" && state.pendingToolCall && (
        <ToolConfirmation
          toolCall={state.pendingToolCall}
          onConfirm={handleToolConfirm}
        />
      )}

      <Composer onSubmit={handleSubmit} disabled={!isComposing} />
      <StatusBar
        model={state.model}
        tokenCount={state.tokenCount}
        phase={state.phase}
      />
    </Box>
  );
}
