import React from "react";
import { Box, Text } from "ink";
import { colors } from "../theme.js";

interface ReviewerNotesProps {
  findings: string[];
}

export default function ReviewerNotes({ findings }: ReviewerNotesProps) {
  if (findings.length === 0) return null;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={colors.accent} paddingX={1} marginBottom={1}>
      <Text bold color={colors.accent}>
        Reviewer notes
      </Text>
      {findings.map((f, i) => (
        <Text key={i} dimColor>
          - {f}
        </Text>
      ))}
    </Box>
  );
}
