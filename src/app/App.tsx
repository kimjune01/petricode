import React from "react";
import { Box, Text, useApp, useInput } from "ink";

export default function App() {
  const { exit } = useApp();

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>🧫 petricode</Text>
      <Text dimColor>Ready. Press q to quit.</Text>
    </Box>
  );
}
