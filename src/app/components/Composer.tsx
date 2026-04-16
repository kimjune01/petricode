import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";
import { colors } from "../theme.js";

interface ComposerProps {
  onSubmit: (text: string) => void;
  disabled: boolean;
  clearSignal?: number;
  phase?: string;
}

export default function Composer({ onSubmit, disabled, clearSignal, phase }: ComposerProps) {
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const prevClear = useRef(clearSignal ?? 0);

  useEffect(() => {
    if (clearSignal !== undefined && clearSignal !== prevClear.current) {
      prevClear.current = clearSignal;
      setInput("");
      setCursor(0);
    }
  }, [clearSignal]);

  useInput(
    (ch, key) => {

      if (key.return) {
        const trimmed = input.trim();
        if (trimmed) {
          onSubmit(trimmed);
          setInput("");
          setCursor(0);
        }
        return;
      }

      // Escape — clear input
      if (key.escape) {
        setInput("");
        setCursor(0);
        return;
      }

      // Ctrl+U — kill line backward (cursor to start)
      if (key.ctrl && ch === "u") {
        setInput(input.slice(cursor));
        setCursor(0);
        return;
      }

      // Ctrl+K — kill line forward (cursor to end)
      if (key.ctrl && ch === "k") {
        setInput(input.slice(0, cursor));
        return;
      }

      // Ctrl+W — delete word backward
      if (key.ctrl && ch === "w") {
        const before = input.slice(0, cursor);
        const trimmed = before.replace(/\S+\s*$/, "");
        setInput(trimmed + input.slice(cursor));
        setCursor(trimmed.length);
        return;
      }

      // Ctrl+A — cursor to start
      if (key.ctrl && ch === "a") {
        setCursor(0);
        return;
      }

      // Ctrl+E — cursor to end
      if (key.ctrl && ch === "e") {
        setCursor(input.length);
        return;
      }

      // Left arrow / Ctrl+B — cursor left
      if (key.leftArrow || (key.ctrl && ch === "b")) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }

      // Right arrow / Ctrl+F — cursor right
      if (key.rightArrow || (key.ctrl && ch === "f")) {
        setCursor((c) => Math.min(input.length, c + 1));
        return;
      }

      // Backspace — delete char before cursor
      if (key.backspace || key.delete) {
        if (cursor > 0) {
          setInput(input.slice(0, cursor - 1) + input.slice(cursor));
          setCursor((c) => c - 1);
        }
        return;
      }

      // Ctrl+D — delete char at cursor (or exit if empty)
      if (key.ctrl && ch === "d") {
        if (input.length === 0) return; // let App handle Ctrl+D exit
        if (cursor < input.length) {
          setInput(input.slice(0, cursor) + input.slice(cursor + 1));
        }
        return;
      }

      // Ignore other control sequences
      if (key.ctrl || key.meta) return;

      // Regular character — insert at cursor
      if (ch) {
        setInput(input.slice(0, cursor) + ch + input.slice(cursor));
        setCursor((c) => c + 1);
      }
    },
    { isActive: !disabled },
  );

  const before = input.slice(0, cursor);
  const at = input[cursor] ?? "";
  const after = input.slice(cursor + 1);

  return (
    <Box>
      <Text bold color={colors.prompt}>
        {">"}{" "}
      </Text>
      {disabled ? (
        <Text dimColor>{phase === "running" ? "thinking…" : phase === "confirming" ? "confirm tool call" : "…"}</Text>
      ) : (
        <Text>
          {before}
          <Text inverse>{at || " "}</Text>
          {after}
        </Text>
      )}
    </Box>
  );
}
