import React, { useState, useCallback, useRef, useEffect } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { Turn, ToolCall } from "../core/types.js";
import type { AppPhase } from "./state.js";
import { initialState } from "./state.js";
import { tryCommand } from "../commands/index.js";
import type { Pipeline } from "../agent/pipeline.js";
import type { ConfirmMode } from "../config/models.js";
import { spacing } from "./theme.js";
import MessageList from "./components/MessageList.js";
import Composer from "./components/Composer.js";
import ToolConfirmation from "./components/ToolConfirmation.js";
import StatusBar from "./components/StatusBar.js";
import ReviewerNotes from "./components/ReviewerNotes.js";
import ErrorDisplay from "./components/ErrorDisplay.js";

export interface AppProps {
  pipeline?: Pipeline;
  resumeSessionId?: string;
  mode?: ConfirmMode;
}

export default function App({ pipeline, resumeSessionId, mode = "cautious" }: AppProps) {
  const { exit } = useApp();
  const [state, setState] = useState(() => {
    const s = initialState();
    if (pipeline) {
      s.model = pipeline.modelId();
    }
    return s;
  });
  const [reviewerFindings, setReviewerFindings] = useState<string[]>([]);
  const [contextSummary, setContextSummary] = useState<string | undefined>(undefined);
  const confirmResolveRef = useRef<((allowed: boolean) => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const ctrlCTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Wire pipeline's onConfirm to TUI confirmation flow
  useEffect(() => {
    if (!pipeline) return;
    pipeline.onConfirm = (toolCall: ToolCall) =>
      new Promise<boolean>((resolve) => {
        confirmResolveRef.current = resolve;
        setState((prev) => ({
          ...prev,
          phase: "confirming" as AppPhase,
          pendingToolCall: toolCall,
        }));
      });
    return () => {
      pipeline.onConfirm = undefined;
    };
  }, [pipeline]);

  useEffect(() => {
    if (!pipeline) return;
    pipeline.contextSummary().then(({ fileCount, tokenEstimate }) => {
      if (fileCount > 0) {
        setContextSummary(`Loaded ${fileCount} context file${fileCount === 1 ? "" : "s"} (${tokenEstimate.toLocaleString()} tokens)`);
      }
    }).catch((err) => {
      setContextSummary(`⚠ Failed to load context: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, [pipeline]);

  // Abort in-flight pipeline on unmount to prevent process hang
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const [ctrlCPending, setCtrlCPending] = useState(false);
  const [clearCount, setClearCount] = useState(0);

  useInput((_ch, key) => {
    if (key.ctrl && _ch === "c") {
      // During running or confirming phase, Ctrl+C interrupts the pipeline
      if ((state.phase === "running" || state.phase === "confirming") && abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
        // If confirming, also reject the pending confirmation to unblock the pipeline
        if (confirmResolveRef.current) {
          confirmResolveRef.current(false);
          confirmResolveRef.current = null;
        }
        addSystemTurn("Interrupted.");
        setState((prev) => ({ ...prev, phase: "composing" as AppPhase, pendingToolCall: null }));
        return;
      }
      if (ctrlCPending) {
        // Double Ctrl+C — exit
        exit();
      } else {
        // First Ctrl+C — clear input, set pending for second tap
        setClearCount((c) => c + 1);
        setCtrlCPending(true);
        // Clear previous timer to prevent stale timeout
        if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current);
        ctrlCTimerRef.current = setTimeout(() => {
          setCtrlCPending(false);
          ctrlCTimerRef.current = null;
        }, 1000);
      }
      return;
    }
    // Any other key cancels the Ctrl+C pending state
    if (ctrlCPending) {
      setCtrlCPending(false);
      if (ctrlCTimerRef.current) {
        clearTimeout(ctrlCTimerRef.current);
        ctrlCTimerRef.current = null;
      }
    }

    // Ctrl+D EOF is owned by Composer (only triggers when its input is empty)
    // so a user mid-typing isn't ejected by the parallel handler.

    // Quick quit when idle
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
      // Guard against double-submit while a turn is in flight
      if (abortRef.current) return;

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
        const controller = new AbortController();
        abortRef.current = controller;
        const resultTurn = await pipeline.turn(input, { signal: controller.signal });
        abortRef.current = null;
        setState((prev) => ({
          ...prev,
          phase: "composing" as AppPhase,
          turns: [...prev.turns, resultTurn],
          tokenCount: pipeline.tokenCount(),
          error: null,
        }));
      } catch (err) {
        abortRef.current = null;
        // Abort is not an error — user already saw "Interrupted."
        if (err instanceof DOMException && err.name === "AbortError") return;
        const errMsg = err instanceof Error ? err.message : String(err);
        const failedTurn: Turn = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: [{ type: "text", text: `[error] ${errMsg}` }],
          timestamp: Date.now(),
        };
        setState((prev) => ({
          ...prev,
          phase: "composing" as AppPhase,
          turns: [...prev.turns, failedTurn],
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
    <Box flexDirection="column" padding={spacing.sm}>
      <Text bold>🧫 petricode</Text>
      <Box flexDirection="column" flexGrow={1} marginY={spacing.sm}>
        <MessageList turns={state.turns} />
        <ReviewerNotes findings={reviewerFindings} />
      </Box>

      <ErrorDisplay error={state.error} />

      {state.phase === "confirming" && state.pendingToolCall && (
        <ToolConfirmation
          toolCall={state.pendingToolCall}
          onConfirm={handleToolConfirm}
          mode={mode}
        />
      )}

      <Composer onSubmit={handleSubmit} disabled={!isComposing} clearSignal={clearCount} phase={state.phase} onEofExit={exit} />
      <StatusBar
        model={state.model}
        tokenCount={state.tokenCount}
        phase={state.phase}
        contextSummary={contextSummary}
      />
    </Box>
  );
}
