import React, { useState, useCallback, useRef, useEffect } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { Turn, ToolCall } from "../core/types.js";
import type { Classification } from "../filter/triageClassifier.js";
import type { ConfirmAlternative, ConfirmDecision } from "../agent/toolSubpipe.js";
import type { AppPhase } from "./state.js";
import { initialState } from "./state.js";
import { tryCommand, overrideCommand } from "../commands/index.js";
import { listSkills } from "../commands/skills.js";
import type { Pipeline } from "../agent/pipeline.js";
import { listKnownModels, type ConfirmMode } from "../config/models.js";
import type { ShareBridge } from "../share/bridge.js";
import type { ShareServer } from "../share/server.js";
import type { InviteRegistry } from "../share/invites.js";
import { makeShareHandler, makeRevokeHandler } from "../commands/share.js";
import { spacing } from "./theme.js";
import MessageList from "./components/MessageList.js";
import Composer from "./components/Composer.js";
import ToolConfirmation from "./components/ToolConfirmation.js";
import StatusBar from "./components/StatusBar.js";
import ReviewerNotes from "./components/ReviewerNotes.js";
import ErrorDisplay from "./components/ErrorDisplay.js";

export interface ShareContext {
  bridge: ShareBridge;
  server: ShareServer;
  invites: InviteRegistry;
  sessionId: string;
  shareHost?: string;
}

export interface AppProps {
  pipeline?: Pipeline;
  resumeSessionId?: string;
  mode?: ConfirmMode;
  share?: ShareContext;
}

export default function App({ pipeline, resumeSessionId, mode = "cautious", share }: AppProps) {
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
  // Live text the model is currently streaming. Throttled to reduce
  // terminal repaint churn — chunks accumulate in a ref and flush to
  // state every 80ms so scrollback stays usable during streaming.
  const [streamingText, setStreamingText] = useState("");
  const streamBufRef = useRef("");
  const streamFlushRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const lastFlushedRef = useRef("");

  const startStreamThrottle = useCallback(() => {
    streamBufRef.current = "";
    lastFlushedRef.current = "";
    if (streamFlushRef.current) clearInterval(streamFlushRef.current);
    streamFlushRef.current = setInterval(() => {
      if (streamBufRef.current !== lastFlushedRef.current) {
        lastFlushedRef.current = streamBufRef.current;
        setStreamingText(streamBufRef.current);
      }
    }, 200);
  }, []);

  const stopStreamThrottle = useCallback(() => {
    if (streamFlushRef.current) {
      clearInterval(streamFlushRef.current);
      streamFlushRef.current = null;
    }
    setStreamingText(streamBufRef.current);
    streamBufRef.current = "";
  }, []);
  // Ctrl+C during a confirmation prompt must REJECT, not resolve("deny").
  // Resolving "deny" reaches toolSubpipe as a user denial and gets recorded
  // as "Denied by user" — making the LLM think the user evaluated and
  // rejected this specific call. Rejecting with AbortError instead routes
  // through the partial-results abort path with "Interrupted by user".
  const confirmResolveRef = useRef<{
    resolve: (decision: ConfirmDecision) => void;
    reject: (err: unknown) => void;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const ctrlCTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The classifier verdict that came in alongside the current ASK_USER
  // confirmation. Cleared when the prompt resolves or the run aborts.
  // (Earlier revs also stashed every verdict in a Map for "lookup", but
  // onConfirm receives the classification directly — the Map was dead
  // state, so we just track the one currently on screen.)
  const [pendingClassification, setPendingClassification] = useState<
    Classification | undefined
  >(undefined);
  const [pendingAlternative, setPendingAlternative] = useState<
    ConfirmAlternative | undefined
  >(undefined);

  // Wire pipeline's onConfirm to TUI confirmation flow
  useEffect(() => {
    if (!pipeline) return;
    pipeline.onConfirm = (
      toolCall: ToolCall,
      classification?: Classification,
      alternative?: ConfirmAlternative,
    ) =>
      new Promise<ConfirmDecision>((resolve, reject) => {
        confirmResolveRef.current = { resolve, reject };
        setPendingClassification(classification);
        setPendingAlternative(alternative);
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
    if (!share) return;
    overrideCommand("share", makeShareHandler(share));
    overrideCommand("revoke", makeRevokeHandler(share));
  }, [share]);

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

  // Abort in-flight pipeline on unmount to prevent process hang. Also
  // clear the Ctrl+C double-tap timer so a pending timeout can't fire
  // setState() against an unmounted component. Reject any pending
  // confirmation promise too — toolSubpipe awaits onConfirm without
  // racing the abort signal, so an unmount mid-prompt would otherwise
  // leave the pipeline thread parked on a never-resolving promise.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (confirmResolveRef.current) {
        confirmResolveRef.current.reject(new DOMException("Aborted", "AbortError"));
        confirmResolveRef.current = null;
      }
      if (ctrlCTimerRef.current) {
        clearTimeout(ctrlCTimerRef.current);
        ctrlCTimerRef.current = null;
      }
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
        // If confirming, REJECT the pending confirmation (don't resolve false)
        // so toolSubpipe routes through interruptedResult, not "Denied by user".
        if (confirmResolveRef.current) {
          confirmResolveRef.current.reject(new DOMException("Aborted", "AbortError"));
          confirmResolveRef.current = null;
        }
        setPendingClassification(undefined);
        setPendingAlternative(undefined);
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

  // Poll guest message queue while idle — process guest messages even
  // when the host hasn't submitted anything.
  useEffect(() => {
    if (!share || !pipeline) return;
    const interval = setInterval(async () => {
      if (state.phase !== "composing" || !share.bridge.hasPendingMessages()) return;
      if (abortRef.current) return;

      const controller = new AbortController();
      abortRef.current = controller;
      setState((prev) => ({ ...prev, phase: "running" as AppPhase }));

      try {
        const pending = share.bridge.drainQueue();
        for (const msg of pending) {
          if (controller.signal.aborted) break;
          share.bridge.emitGuestMessage(msg);

          // Show guest message immediately before pipeline runs
          const guestUserTurn: Turn = {
            id: crypto.randomUUID(),
            role: "user",
            content: [{ type: "text", text: `[${msg.actor}] ${msg.text}` }],
            timestamp: Date.now(),
          };
          setState((prev) => ({
            ...prev,
            turns: [...prev.turns, guestUserTurn],
          }));

          startStreamThrottle();
          const guestTurn = await pipeline.turn(msg.text, {
            signal: controller.signal,
            onText: (delta) => {
              streamBufRef.current += delta;
              share.bridge.emitStreamChunk(delta);
            },
          });
          share.bridge.emitAssistantTurn(guestTurn);
          stopStreamThrottle();
          setState((prev) => ({
            ...prev,
            turns: [...prev.turns, guestTurn],
            tokenCount: pipeline.tokenCount(),
          }));
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          const errMsg = err instanceof Error ? err.message : String(err);
          addSystemTurn(`[guest error] ${errMsg}`);
        }
        stopStreamThrottle();
      }

      if (abortRef.current === controller) abortRef.current = null;
      setState((prev) => ({ ...prev, phase: "composing" as AppPhase }));
    }, 500);

    return () => clearInterval(interval);
  }, [share, pipeline, state.phase, addSystemTurn, startStreamThrottle, stopStreamThrottle]);

  // Surface ALLOW verdicts inline so users see what auto-ran without a
  // y/n. ASK_USER's rationale is rendered inside ToolConfirmation via
  // pendingClassification; DENY surfaces as a tool_result back to the
  // model — neither needs an extra system turn here.
  useEffect(() => {
    if (!pipeline) return;
    pipeline.onClassified = (toolCall, classification) => {
      if (classification.verdict !== "ALLOW") return;
      // Strip ANSI from the LLM-generated rationale before rendering —
      // Ink doesn't sanitize, so a crafted rationale could clear the
      // screen or spoof terminal output. C1 range (\x80–\x9f) blocks
      // 8-bit CSI bypass (\x9b instead of \x1b[). Preserve \t (\x09),
      // \n (\x0a), \r (\x0d) — stripping them squashes multi-line
      // rationales into one illegible run.
      // CSI/OSC sequences must come BEFORE the single-char control set:
      // \x1b lives inside \x0e-\x1f, so the single-char branch eagerly
      // consumes the ESC alone and leaves the `[31m`/`]8;;…` payload
      // as literal text in the rendered TUI. Multi-char branches go
      // first; the single-char fallback only fires for stray controls.
      // eslint-disable-next-line no-control-regex
      const safe = classification.rationale.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
      addSystemTurn(`[triage ALLOW] ${toolCall.name} — ${safe}`);
    };
    return () => {
      pipeline.onClassified = undefined;
    };
  }, [pipeline, addSystemTurn]);

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
          const handleResult = (result: { output: string; exit?: boolean }) => {
            if (skillCmdName === "clear") {
              pipeline?.clear();
              setState((prev) => ({
                ...prev,
                turns: [],
                error: null,
                tokenCount: pipeline?.tokenCount() ?? prev.tokenCount,
              }));
              addSystemTurn(result.output);
              return;
            }

            addSystemTurn(result.output);
            if (result.exit) {
              exit();
            }
          };

          if (cmdResult instanceof Promise) {
            addSystemTurn("Starting share server...");
            setState((prev) => ({ ...prev, phase: "running" as AppPhase }));
            cmdResult.then((r) => {
              handleResult(r);
              setState((prev) => ({ ...prev, phase: "composing" as AppPhase }));
            });
          } else {
            handleResult(cmdResult);
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

      startStreamThrottle();
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

      const controller = new AbortController();
      try {
        abortRef.current = controller;

        share?.bridge.emitUserTurn(userTurn);

        const resultTurn = await pipeline.turn(input, {
          signal: controller.signal,
          onText: (delta) => {
            streamBufRef.current += delta;
            share?.bridge.emitStreamChunk(delta);
          },
        });
        share?.bridge.emitAssistantTurn(resultTurn);

        // Append host result BEFORE draining guests so local TUI order
        // matches remote SSE order: host user → host assistant → guest → ...
        stopStreamThrottle();
        setState((prev) => ({
          ...prev,
          turns: [...prev.turns, resultTurn],
          tokenCount: pipeline.tokenCount(),
        }));

        // Drain guest message queue. Loop until empty (with fairness
        // cap) so messages arriving during drain aren't stalled until
        // the next host turn. abortRef stays set so Ctrl+C works.
        if (share) {
          const MAX_GUEST_DRAIN = 10;
          let drained = 0;
          while (share.bridge.hasPendingMessages() && drained < MAX_GUEST_DRAIN) {
            const pending = share.bridge.drainQueue();
            for (const msg of pending) {
              if (controller.signal.aborted) break;
              drained++;
              share.bridge.emitGuestMessage(msg);

              const guestUserTurn: Turn = {
                id: crypto.randomUUID(),
                role: "user",
                content: [{ type: "text", text: `[${msg.actor}] ${msg.text}` }],
                timestamp: Date.now(),
              };
              setState((prev) => ({
                ...prev,
                turns: [...prev.turns, guestUserTurn],
              }));

              startStreamThrottle();
              const guestTurn = await pipeline.turn(msg.text, {
                signal: controller.signal,
                onText: (delta) => {
                  streamBufRef.current += delta;
                  share.bridge.emitStreamChunk(delta);
                },
              });
              share.bridge.emitAssistantTurn(guestTurn);
              stopStreamThrottle();
              setState((prev) => ({
                ...prev,
                turns: [...prev.turns, guestTurn],
                tokenCount: pipeline.tokenCount(),
              }));
            }
            if (controller.signal.aborted) break;
          }
        }

        // Clear abort ref only after all work (host + guest) is done
        if (abortRef.current === controller) abortRef.current = null;
        setState((prev) => ({
          ...prev,
          phase: "composing" as AppPhase,
          error: null,
        }));
      } catch (err) {
        // Same identity guard as the success path — a settled abort
        // for turn 1 must not erase the controller for turn 2.
        if (abortRef.current === controller) abortRef.current = null;
        stopStreamThrottle();
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
        const rawMsg = err instanceof Error ? err.message : String(err);
        let errMsg = rawMsg;
        if (rawMsg.includes("Could not resolve authentication method")) {
          const usingVertex = process.env.CLAUDE_CODE_USE_VERTEX === "1" || !!process.env.ANTHROPIC_VERTEX_PROJECT_ID;
          if (usingVertex) {
            errMsg = [
              rawMsg,
              "",
              "Vertex AI auth failed. Check:",
              `  GOOGLE_APPLICATION_CREDENTIALS=${process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "<not set>"}`,
              `  ANTHROPIC_VERTEX_PROJECT_ID=${process.env.ANTHROPIC_VERTEX_PROJECT_ID ?? "<not set>"}`,
              `  ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ? "(set — should be unset for Vertex)" : "(not set — ok)"}`,
              "",
              "If using a service account, ensure the key file exists and has Vertex AI permissions.",
            ].join("\n");
          } else {
            errMsg = [
              rawMsg,
              "",
              "Set ANTHROPIC_API_KEY or configure Vertex AI:",
              "  export ANTHROPIC_API_KEY=sk-ant-...",
              "  # or for Vertex:",
              "  export ANTHROPIC_VERTEX_PROJECT_ID=your-project",
              "  export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json",
            ].join("\n");
          }
        } else if (rawMsg.includes("429") || rawMsg.includes("RESOURCE_EXHAUSTED")) {
          errMsg = `${rawMsg}\n\nRate limited. Wait a moment and try again, or check your Vertex AI quota.`;
        }
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

  const handleToolConfirm = useCallback((decision: ConfirmDecision) => {
    if (!state.pendingToolCall) return;

    // Race guard: if Ctrl+C just fired in the same stdin chunk (terminal
    // coalesces ^Cy / ^Cn into one read), the Ctrl+C handler already
    // nulled confirmResolveRef and queued a "composing" setState. We
    // can't trust state.pendingToolCall here because the setState hasn't
    // committed yet. Without this guard, we'd emit a spurious
    // "Allowed: <toolname>" system turn and override the "composing"
    // setState with "running", leaving the TUI stuck on the spinner
    // with no pipeline in flight.
    if (!confirmResolveRef.current) return;
    confirmResolveRef.current.resolve(decision);
    confirmResolveRef.current = null;

    const name = state.pendingToolCall.name;
    const summary =
      decision === "allow"
        ? `Allowed: ${name}`
        : decision === "alternative"
          ? `Substituted safer form: ${name}${pendingAlternative ? ` (${pendingAlternative.label})` : ""}`
          : `Denied: ${name}`;
    addSystemTurn(summary);
    setPendingClassification(undefined);
    setPendingAlternative(undefined);
    setState((prev) => ({
      ...prev,
      phase: "running" as AppPhase,
      pendingToolCall: null,
    }));
  }, [state.pendingToolCall, pendingAlternative, addSystemTurn]);

  const isComposing = state.phase === "composing";

  return (
    <Box flexDirection="column" padding={spacing.sm}>
      <Text bold>🧫 petricode</Text>
      <Box flexDirection="column" flexGrow={1} marginY={spacing.sm}>
        <MessageList turns={state.turns} phase={state.phase} streamingText={streamingText} />
        <ReviewerNotes findings={reviewerFindings} />
      </Box>

      <ErrorDisplay error={state.error} />

      {state.phase === "confirming" && state.pendingToolCall && (
        <ToolConfirmation
          toolCall={state.pendingToolCall}
          onConfirm={handleToolConfirm}
          mode={mode}
          classification={pendingClassification}
          alternative={pendingAlternative}
        />
      )}

      <Composer onSubmit={handleSubmit} disabled={!isComposing} clearSignal={clearCount} phase={state.phase} onEofExit={exit} />
      <StatusBar
        model={state.model}
        tokenCount={state.tokenCount}
        phase={state.phase}
        contextSummary={contextSummary}
        mode={mode}
      />
    </Box>
  );
}
