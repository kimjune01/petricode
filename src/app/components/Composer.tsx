import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

interface ComposerProps {
  onSubmit: (text: string) => void;
  disabled: boolean;
}

export default function Composer({ onSubmit, disabled }: ComposerProps) {
  const [input, setInput] = useState("");

  useInput(
    (ch, key) => {
      if (disabled) return;

      if (key.return) {
        const trimmed = input.trim();
        if (trimmed) {
          onSubmit(trimmed);
          setInput("");
        }
        return;
      }

      if (key.backspace || key.delete) {
        setInput((prev) => prev.slice(0, -1));
        return;
      }

      // Ignore control sequences except basic chars
      if (key.ctrl || key.meta) return;

      if (ch) {
        setInput((prev) => prev + ch);
      }
    },
  );

  return (
    <Box>
      <Text bold color="green">
        {">"}{" "}
      </Text>
      <Text>{disabled ? "..." : input}</Text>
      {!disabled && <Text color="gray">|</Text>}
    </Box>
  );
}
