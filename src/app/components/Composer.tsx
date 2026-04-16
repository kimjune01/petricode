import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useInput, useStdin } from "ink";
import { colors } from "../theme.js";

// Bracketed paste escape sequences
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

interface ComposerState {
  input: string;
  cursor: number;
}

interface ComposerProps {
  onSubmit: (text: string) => void;
  disabled: boolean;
  clearSignal?: number;
  phase?: string;
  /** Called when Ctrl+D is pressed and the input is empty (EOF). */
  onEofExit?: () => void;
}

export default function Composer({ onSubmit, disabled, clearSignal, phase, onEofExit }: ComposerProps) {
  // Sync ref + async state eliminates stale closures during rapid keypresses.
  // All mutations go through updateState which writes both synchronously (ref)
  // and asynchronously (setState for re-render).
  const stateRef = useRef<ComposerState>({ input: "", cursor: 0 });
  const [renderState, setRenderState] = useState<ComposerState>(stateRef.current);

  const updateState = (updater: (prev: ComposerState) => ComposerState) => {
    stateRef.current = updater(stateRef.current);
    setRenderState(stateRef.current);
  };

  const prevClear = useRef(clearSignal ?? 0);
  const isPasting = useRef(false);

  // Access Ink's internal event emitter which emits raw stdin chunks.
  // NOTE: We intentionally use internal_eventEmitter rather than stdin directly
  // because Ink reads stdin in paused mode ('readable' + read()). Attaching a
  // 'data' listener would switch to flowing mode and break Ink's own reading.
  const { internal_eventEmitter } = useStdin() as ReturnType<typeof useStdin> & {
    internal_eventEmitter?: import("events").EventEmitter;
  };

  // Enable bracketed paste mode in the terminal
  useEffect(() => {
    process.stdout.write("\x1b[?2004h");
    return () => {
      process.stdout.write("\x1b[?2004l");
    };
  }, []);

  useEffect(() => {
    if (clearSignal !== undefined && clearSignal !== prevClear.current) {
      prevClear.current = clearSignal;
      updateState(() => ({ input: "", cursor: 0 }));
    }
  }, [clearSignal]);

  // Intercept raw stdin chunks (via Ink's internal event emitter) to detect
  // bracketed paste sequences before useInput's parseKeypress mangles them.
  // Handles chunk fragmentation (paste split across multiple data events).
  useEffect(() => {
    if (disabled || !internal_eventEmitter) return;
    let pasteBuffer = "";

    const onRawInput = (data: string) => {
      const s = String(data);

      if (s.includes(PASTE_START)) {
        isPasting.current = true;
        pasteBuffer = s.substring(s.indexOf(PASTE_START) + PASTE_START.length);
      } else if (isPasting.current) {
        pasteBuffer += s;
      }

      if (isPasting.current && pasteBuffer.includes(PASTE_END)) {
        const endIdx = pasteBuffer.indexOf(PASTE_END);
        const payload = pasteBuffer.substring(0, endIdx);
        // Append any printable bytes that arrived in the same stdin chunk
        // after PASTE_END. Ink's parseKeypress will emit keypress events
        // for them synchronously, but our useInput drops those (isPasting
        // stays true through the current tick) — so we'd otherwise lose
        // them entirely. Strip ANSI escapes and most control chars; keep
        // tab and newline.
        const tail = pasteBuffer.substring(endIdx + PASTE_END.length);
        const tailPrintable = tail.replace(/\x1b\[[0-9;]*[a-zA-Z]|[\x00-\x08\x0b-\x1f\x7f]/g, "");
        const combined = payload + tailPrintable;
        pasteBuffer = "";

        updateState((prev) => ({
          input: prev.input.slice(0, prev.cursor) + combined + prev.input.slice(prev.cursor),
          cursor: prev.cursor + combined.length,
        }));

        // Keep isPasting true through the current tick so useInput ignores
        // the duplicate keypress events that Ink's parseKeypress fires
        // synchronously from the same stdin chunk.
        process.nextTick(() => {
          isPasting.current = false;
        });
      }
    };

    // Prepend so we run before useInput's listener
    internal_eventEmitter.prependListener("input", onRawInput);
    return () => {
      internal_eventEmitter.removeListener("input", onRawInput);
      isPasting.current = false;
    };
  }, [disabled, internal_eventEmitter]);

  useInput(
    (ch, key) => {
      // Mute all input while a bracketed paste is active
      if (isPasting.current) return;

      if (key.return) {
        // Read from sync ref to guarantee latest state even if a character
        // was inserted in the same event-loop tick
        const trimmed = stateRef.current.input.trim();
        if (trimmed) {
          onSubmit(trimmed);
          updateState(() => ({ input: "", cursor: 0 }));
        }
        return;
      }

      // Escape — clear input
      if (key.escape) {
        updateState(() => ({ input: "", cursor: 0 }));
        return;
      }

      updateState((prev) => {
        let nextInput = prev.input;
        let nextCursor = prev.cursor;

        // Ctrl+U — kill line backward (cursor to start)
        if (key.ctrl && ch === "u") {
          nextInput = prev.input.slice(prev.cursor);
          nextCursor = 0;
        }
        // Ctrl+K — kill line forward (cursor to end)
        else if (key.ctrl && ch === "k") {
          nextInput = prev.input.slice(0, prev.cursor);
        }
        // Ctrl+W — delete word backward
        else if (key.ctrl && ch === "w") {
          const before = prev.input.slice(0, prev.cursor);
          const trimmed = before.replace(/\S+\s*$/, "");
          nextInput = trimmed + prev.input.slice(prev.cursor);
          nextCursor = trimmed.length;
        }
        // Ctrl+A — cursor to start
        else if (key.ctrl && ch === "a") {
          nextCursor = 0;
        }
        // Ctrl+E — cursor to end
        else if (key.ctrl && ch === "e") {
          nextCursor = prev.input.length;
        }
        // Left arrow / Ctrl+B — cursor left
        else if (key.leftArrow || (key.ctrl && ch === "b")) {
          nextCursor = Math.max(0, prev.cursor - 1);
        }
        // Right arrow / Ctrl+F — cursor right
        else if (key.rightArrow || (key.ctrl && ch === "f")) {
          nextCursor = Math.min(prev.input.length, prev.cursor + 1);
        }
        // Backspace — delete char before cursor
        else if (key.backspace) {
          if (prev.cursor > 0) {
            nextInput = prev.input.slice(0, prev.cursor - 1) + prev.input.slice(prev.cursor);
            nextCursor = prev.cursor - 1;
          }
        }
        // Delete / Ctrl+D — delete char at cursor (forward delete);
        // empty input + Ctrl+D = EOF exit (standard shell behavior).
        else if (key.delete || (key.ctrl && ch === "d")) {
          if (prev.input.length === 0 && key.ctrl && ch === "d") {
            onEofExit?.();
            return prev;
          }
          if (prev.cursor < prev.input.length) {
            nextInput = prev.input.slice(0, prev.cursor) + prev.input.slice(prev.cursor + 1);
          }
        }
        // Ignore other control sequences
        else if (key.ctrl || key.meta) {
          return prev;
        }
        // Regular character — insert at cursor
        else if (ch) {
          nextInput = prev.input.slice(0, prev.cursor) + ch + prev.input.slice(prev.cursor);
          nextCursor = prev.cursor + 1;
        }

        return { input: nextInput, cursor: nextCursor };
      });
    },
    { isActive: !disabled },
  );

  // ── Render ──
  const { input, cursor } = renderState;
  const lines = input.split("\n");
  const isMultiline = lines.length > 1;

  const before = input.slice(0, cursor);
  const at = input[cursor] ?? "";
  const after = input.slice(cursor + 1);

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color={colors.prompt}>
          {">"}{" "}
        </Text>
        {disabled ? (
          <Text dimColor>{phase === "running" ? "thinking…" : phase === "confirming" ? "confirm tool call" : "…"}</Text>
        ) : (
          <Text>
            {before}
            <Text inverse>{at === "\n" ? " " : (at || " ")}</Text>{at === "\n" ? "\n" : null}
            {after}
          </Text>
        )}
      </Box>
      {!disabled && isMultiline && (
        <Box>
          <Text dimColor>  (pasted {lines.length} lines — Enter to send, Esc to clear)</Text>
        </Box>
      )}
    </Box>
  );
}
