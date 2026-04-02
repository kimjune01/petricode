import React from "react";
import { Box, Text } from "ink";

interface ReviewerNotesProps {
  findings: string[];
}

export default function ReviewerNotes({ findings }: ReviewerNotesProps) {
  if (findings.length === 0) return null;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="magenta" paddingX={1} marginBottom={1}>
      <Text bold color="magenta">
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
