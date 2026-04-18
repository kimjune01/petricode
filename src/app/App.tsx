import React, { useState, useCallback, useRef, useEffect } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { Turn, ToolCall } from "../core/types.js";
import type { AppPhase } from "./state.js";
import { initialState } from "./state.js";
import { tryCommand, overrideCommand } from "../commands/index.js";
import { listSkills } from "../commands/skills.js";
import type { Pipeline } from "../agent/pipeline.js";
import { listKnownModels, type ConfirmMode } from "../config/models.js";
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

  // Wire pipeline-backed slash commands. Done here (not at module load)
  // because /skills needs pipeline.loadedSkills() and /compact needs the
  // pipeline's cache.
  useEffect(() => {
    if (!pipeline) return;
    overrideCommand("skills", () => listSkills(pipeline.loadedSkills()));
    overrideCommand("compact", () => {
      const { removed_tokens, preserved_pct } = pipeline.compact();
      const after = pipeline.tokenCount();
      setState((prev) => ({ ...prev, tokenCount: after }));
      const pct = Math.round(preserved_pct * 100);
      return {
        output: `Compacted: -${removed_tokens} tokens (${pct}% preserved, now ${after})`,
      };
    });
    overrideCommand("model", (args) => {
      const trimmed = args.trim();
      if (!trimmed) {
        const models = listKnownModels().sort().map((m) => `  ${m}`).join("\n");
        return {
          output: `Current: ${pipeline.modelId()}\n\nAvailable:\n${models}\n\nUsage: /model <name>`,
        };
      }
      try {
        const { previous, current } = pipeline.setPrimaryModel(trimmed);
        setState((prev) => ({ ...prev, model: current }));
        return { output: `Model: ${previous} → ${current}` };
      } catch (err) {
        return {
          output: `Error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    });
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

      // Check for slash commands first — but skip the built-in registry if
      // the input matches a loaded slash_command skill, so user-authored
      // skills don't get intercepted as "Unknown command" before the
      // pipeline ever sees them. The pipeline's matchSlashCommand handles
      // activation and $ARGUMENTS substitution downstream.
      const trimmedInput = input.trim();
      const skillCmdName = trimmedInput.startsWith("/")
        ? (() => {
            const spaceIdx = trimmedInput.indexOf(" ");
            return spaceIdx === -1
              ? trimmedInput.slice(1)
              : trimmedInput.slice(1, spaceIdx);
          })()
        : null;
      const matchedSlashSkill =
        skillCmdName !== null &&
        !!pipeline?.loadedSkills().some(
          (s) => s.trigger === "slash_command" && s.name === skillCmdName,
        );

      if (!matchedSlashSkill) {
        const cmdResult = tryCommand(input);
        if (cmdResult) {
          // Match on the parsed command name so `/clear something` is
          // treated as /clear (and reports no-such-args), not silently
          // dropped to the generic addSystemTurn branch which printed
          // "Conversation cleared." while leaving turns intact.
          if (skillCmdName === "clear") {
            // Wipe both the React turn list AND the pipeline cache.
            // Without pipeline.clear(), the model kept seeing the full
            // pre-clear history on the next turn even though the UI was
            // empty.
            pipeline?.clear();
            setState((prev) => ({
              ...prev,
              turns: [],
              error: null,
              tokenCount: pipeline?.tokenCount() ?? prev.tokenCount,
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
        // Abort is not surfaced as an error — but we still need to drop
        // back to "composing" or the composer stays disabled. The
        // user-Ctrl+C path already sets phase to "composing" before this
        // catch fires, so the setState here is idempotent for that case
        // and load-bearing for non-user aborts (provider timeout, etc.).
        if (err instanceof DOMException && err.name === "AbortError") {
          setState((prev) =>
            prev.phase === "composing"
              ? prev
              : { ...prev, phase: "composing" as AppPhase },
          );
          return;
        }
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
        <MessageList turns={state.turns} phase={state.phase} />
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
