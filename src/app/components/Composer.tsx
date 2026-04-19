import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useInput, useStdin } from "ink";
import { colors } from "../theme.js";
import { useSpinner } from "../spinner.js";

// Bracketed paste escape sequences
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

// Strip terminal control sequences from raw input. Mirrors App.tsx's
// rationale sanitizer:
//  - CSI (\x1b[…) and OSC (\x1b]…ST) sequences must come first;
//    \x1b lives inside the single-char range below, so listing the
//    range first would eat the ESC and leave the payload visible.
//  - C1 range (\x80-\x9f) blocks 8-bit CSI bypass — pasting raw
//    `\x9b2J` would clear the screen if we only filtered \x1b[.
//  - Preserve \t (\x09), \n (\x0a), \r (\x0d) so multi-line pastes
//    keep their formatting in the composer.
// eslint-disable-next-line no-control-regex
const STRIP_TERM_CTRL = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

// Cursor stepping that respects UTF-16 surrogate pairs. Astral chars (most
// emoji, some CJK) take 2 code units; naive +1/-1 lands the cursor between
// the high and low surrogate, which then gets sliced apart on the next edit
// and renders as U+FFFD. Step by 2 when we see a surrogate boundary.
const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

export const stepLeft = (s: string, idx: number): number => {
  if (idx <= 0) return 0;
  const prev = s.charCodeAt(idx - 1);
  if (isLowSurrogate(prev) && idx >= 2 && isHighSurrogate(s.charCodeAt(idx - 2))) {
    return idx - 2;
  }
  return idx - 1;
};

export const stepRight = (s: string, idx: number): number => {
  if (idx >= s.length) return s.length;
  const cur = s.charCodeAt(idx);
  if (isHighSurrogate(cur) && idx + 1 < s.length && isLowSurrogate(s.charCodeAt(idx + 1))) {
    return idx + 2;
  }
  return idx + 1;
};

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
  const spinner = useSpinner(phase === "running");

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
      pasteBuffer += String(data);

      // Drain as many complete <PASTE_START>…<PASTE_END> regions as we
      // have in the buffer. The previous indexOf-based slicer collapsed
      // when two pastes arrived in one stdin chunk: it kept only the
      // first payload and stripped the rest as raw escape bytes.
      let combined = "";
      let madeProgress = false;
      while (true) {
        if (!isPasting.current) {
          const startIdx = pasteBuffer.indexOf(PASTE_START);
          if (startIdx === -1) {
            // If no paste happened this tick, leftover bytes were already
            // delivered to useInput as keypresses — drop them.
            // If we DID just finish a paste, leftover bytes are typed
            // chars from the same chunk that Ink will fire synchronously
            // after us. The post-loop block below captures and inserts
            // them; the nextTick `isPasting` gate suppresses the dupes.
            if (!madeProgress) pasteBuffer = "";
            break;
          }
          // Pre-paste prefix bytes were keypress events from the same
          // stdin chunk. Ink's listener will fire them synchronously
          // AFTER us, but we're about to set isPasting=true which gates
          // useInput from inserting them. Capture them here as cleaned
          // printable text so they aren't silently dropped.
          if (startIdx > 0) {
            combined += pasteBuffer.substring(0, startIdx).replace(STRIP_TERM_CTRL, "");
          }
          pasteBuffer = pasteBuffer.substring(startIdx + PASTE_START.length);
          isPasting.current = true;
        }
        const endIdx = pasteBuffer.indexOf(PASTE_END);
        if (endIdx === -1) break; // wait for more data
        combined += pasteBuffer.substring(0, endIdx);
        pasteBuffer = pasteBuffer.substring(endIdx + PASTE_END.length);
        isPasting.current = false;
        madeProgress = true;
      }

      // Trailing printable bytes (post-PASTE_END, no further PASTE_START)
      // are characters typed in the same stdin chunk after the paste
      // ended. Ink emits keypresses for them synchronously; we suppress
      // those via the isPasting nextTick gate, so inject them here.
      // Strip ANSI/control to avoid leaking terminal codes.
      if (!isPasting.current && pasteBuffer && !pasteBuffer.includes(PASTE_START)) {
        combined += pasteBuffer.replace(STRIP_TERM_CTRL, "");
        pasteBuffer = "";
      }

      if (madeProgress) {
        if (combined) {
          updateState((prev) => ({
            input: prev.input.slice(0, prev.cursor) + combined + prev.input.slice(prev.cursor),
            cursor: prev.cursor + combined.length,
          }));
        }
        // Re-arm isPasting through the current tick so useInput drops
        // the duplicate keypress events Ink's parseKeypress is about
        // to fire synchronously from the same stdin chunk. Skip if
        // isPasting is already true at end-of-loop — that means a
        // SECOND paste opened mid-chunk and is still waiting for its
        // PASTE_END in a later chunk. An unconditional nextTick reset
        // would clear that state and the next chunk would fail to
        // recognize the in-flight paste, dropping its payload.
        if (!isPasting.current) {
          isPasting.current = true;
          process.nextTick(() => {
            isPasting.current = false;
          });
        }
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
        // Left arrow / Ctrl+B — cursor left.
        // stepLeft jumps 2 over a surrogate pair so the cursor never lands
        // between the high and low halves of an emoji.
        else if (key.leftArrow || (key.ctrl && ch === "b")) {
          nextCursor = stepLeft(prev.input, prev.cursor);
        }
        // Right arrow / Ctrl+F — cursor right
        else if (key.rightArrow || (key.ctrl && ch === "f")) {
          nextCursor = stepRight(prev.input, prev.cursor);
        }
        // Backspace — delete char before cursor.
        // Ink 5.2.1's parseKeypress maps macOS Backspace (\x7f) to
        // `key.delete`, not `key.backspace` (only \x08 / Ctrl+H gets
        // `backspace`). Treat both as backward-delete so the Backspace
        // key actually works on macOS terminals.
        else if (key.backspace || key.delete) {
          if (prev.cursor > 0) {
            // Use stepLeft so backspace deletes the entire emoji (2 code
            // units) rather than the trailing low surrogate, which would
            // leave a dangling high surrogate that renders as U+FFFD.
            const start = stepLeft(prev.input, prev.cursor);
            nextInput = prev.input.slice(0, start) + prev.input.slice(prev.cursor);
            nextCursor = start;
          }
        }
        // Ctrl+D — forward delete at cursor; empty input + Ctrl+D = EOF
        // exit (standard shell behavior).
        else if (key.ctrl && ch === "d") {
          if (prev.input.length === 0) {
            onEofExit?.();
            return prev;
          }
          if (prev.cursor < prev.input.length) {
            const end = stepRight(prev.input, prev.cursor);
            nextInput = prev.input.slice(0, prev.cursor) + prev.input.slice(end);
          }
        }
        // Multi-char chunk — a paste that escaped bracketed-paste detection
        // (terminal didn't send \x1b[200~ wrappers) or arrived with
        // key.meta=true from macOS Cmd+V. Insert the whole payload, but
        // strip ESC sequences and other control bytes so terminal codes
        // don't leak into the input. Checked BEFORE the ctrl/meta drop so
        // Cmd+V's meta flag doesn't swallow the payload.
        else if (ch && ch.length > 1) {
          const cleaned = ch.replace(STRIP_TERM_CTRL, "");
          if (cleaned) {
            nextInput =
              prev.input.slice(0, prev.cursor) +
              cleaned +
              prev.input.slice(prev.cursor);
            nextCursor = prev.cursor + cleaned.length;
          }
        }
        // Ignore other single-char control sequences
        else if (key.ctrl || key.meta) {
          return prev;
        }
        // Regular character — insert at cursor.
        // ch.length (not 1) because a single typed astral char (e.g. emoji
        // delivered as a 2-code-unit string) needs the cursor to advance
        // past both surrogates; otherwise the next keystroke splits the pair.
        else if (ch) {
          nextInput = prev.input.slice(0, prev.cursor) + ch + prev.input.slice(prev.cursor);
          nextCursor = prev.cursor + ch.length;
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

  // Use stepRight to find the end of the cursor-highlighted character so a
  // surrogate pair (emoji) renders as a single inverted glyph instead of
  // splitting across `at`/`after` and producing two replacement characters.
  const before = input.slice(0, cursor);
  const atEnd = stepRight(input, cursor);
  const at = input.slice(cursor, atEnd);
  const after = input.slice(atEnd);

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color={colors.prompt}>
          {">"}{" "}
        </Text>
        {disabled ? (
          <Text dimColor>{phase === "running" ? `${spinner} thinking…` : phase === "confirming" ? "confirm tool call" : "…"}</Text>
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
