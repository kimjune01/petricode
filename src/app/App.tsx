import React, { useState, useCallback, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { Turn, ToolCall } from "../core/types.js";
import type { AppPhase } from "./state.js";
import { initialState } from "./state.js";
import { tryCommand } from "../commands/index.js";
import type { Pipeline } from "../agent/pipeline.js";
import MessageList from "./components/MessageList.js";
import Composer from "./components/Composer.js";
import ToolConfirmation from "./components/ToolConfirmation.js";
import StatusBar from "./components/StatusBar.js";
import ReviewerNotes from "./components/ReviewerNotes.js";
import ErrorDisplay from "./components/ErrorDisplay.js";

export interface AppProps {
  pipeline?: Pipeline;
  resumeSessionId?: string;
}

export default function App({ pipeline, resumeSessionId }: AppProps) {
  const { exit } = useApp();
  const [state, setState] = useState(initialState);
  const [reviewerFindings, setReviewerFindings] = useState<string[]>([]);
  const confirmResolveRef = useRef<((allowed: boolean) => void) | null>(null);

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
    async (input: string) => {
      // Check for slash commands first
      const cmdResult = tryCommand(input);
      if (cmdResult) {
        // Handle /clear — reset turns and error
        if (input.trim() === "/clear") {
          setState((prev) => ({
            ...prev,
            turns: [],
            error: null,
          }));
          addSystemTurn(cmdResult.output);
          return;
        }

        addSystemTurn(cmdResult.output);
        if (cmdResult.exit) {
          exit();
        }
        return;
      }

      // Clear any previous error
      setState((prev) => ({ ...prev, error: null }));

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

      if (!pipeline) {
        // No pipeline wired — stub response
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
        return;
      }

      try {
        const resultTurn = await pipeline.turn(input);
        setState((prev) => ({
          ...prev,
          phase: "composing" as AppPhase,
          turns: [...prev.turns, resultTurn],
          tokenCount: pipeline.tokenCount(),
          error: null,
        }));
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        setState((prev) => ({
          ...prev,
          phase: "composing" as AppPhase,
          error: errMsg,
        }));
      }
    },
    [addSystemTurn, exit, pipeline],
  );

  const handleToolConfirm = useCallback((allowed: boolean) => {
    if (!state.pendingToolCall) return;

    // Resolve the pipeline's ASK_USER promise
    if (confirmResolveRef.current) {
      confirmResolveRef.current(allowed);
      confirmResolveRef.current = null;
    }

    addSystemTurn(
      allowed
        ? `Allowed: ${state.pendingToolCall.name}`
        : `Denied: ${state.pendingToolCall.name}`,
    );
    setState((prev) => ({
      ...prev,
      phase: "running" as AppPhase,
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

      <ErrorDisplay error={state.error} />

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
