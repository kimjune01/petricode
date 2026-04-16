// ── TUI component for reviewing consolidation candidates ────────

import React, { useState } from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { CandidateSkill } from "../../core/types.js";
import { colors } from "../theme.js";

export interface ReviewDecision {
  candidate: CandidateSkill;
  action: "approve" | "reject" | "skip";
}

interface ConsolidateReviewProps {
  candidates: CandidateSkill[];
  onComplete: (decisions: ReviewDecision[]) => void;
}

export default function ConsolidateReview({
  candidates,
  onComplete,
}: ConsolidateReviewProps) {
  const [index, setIndex] = useState(0);
  const [decisions, setDecisions] = useState<ReviewDecision[]>([]);
  const { exit } = useApp();

  const current = candidates[index];
  const isLast = index >= candidates.length;

  useInput((input, key) => {
    if (isLast) return;

    const decide = (action: ReviewDecision["action"]) => {
      const next = [...decisions, { candidate: current!, action }];
      setDecisions(next);
      if (index + 1 >= candidates.length) {
        setIndex(index + 1);
        onComplete(next);
      } else {
        setIndex(index + 1);
      }
    };

    switch (input) {
      case "a":
        decide("approve");
        break;
      case "r":
        decide("reject");
        break;
      case "s":
        decide("skip");
        break;
      case "d":
        onComplete(decisions);
        break;
    }
  });

  if (isLast || candidates.length === 0) {
    const approved = decisions.filter((d) => d.action === "approve").length;
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color={colors.prompt}>
          Review complete. {approved} skill{approved !== 1 ? "s" : ""} approved.
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold>
          Candidate {index + 1}/{candidates.length}
        </Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={colors.user}>
          {current!.name}
        </Text>
        <Text dimColor>
          confidence: {(current!.confidence * 100).toFixed(0)}% | sources:{" "}
          {current!.source_sessions.join(", ")}
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text>{current!.body}</Text>
      </Box>

      <Box>
        <Text dimColor>
          [a]pprove [r]eject [s]kip [d]one
        </Text>
      </Box>
    </Box>
  );
}
