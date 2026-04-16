// ── TUI component for reviewing consolidation candidates ────────

import React, { useRef, useState } from "react";
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

  // Refs hold the authoritative values across rapid keypresses. Without
  // them, two useInput callbacks fired in the same React commit phase both
  // close over the same stale `index` / `decisions` and clobber each other:
  // the first decision is dropped, a candidate is skipped silently.
  const indexRef = useRef(0);
  const decisionsRef = useRef<ReviewDecision[]>([]);

  const current = candidates[index];
  const isLast = index >= candidates.length;

  useInput((input, key) => {
    const i = indexRef.current;
    if (i >= candidates.length) return;

    const decide = (action: ReviewDecision["action"]) => {
      const cand = candidates[i]!;
      const next = [...decisionsRef.current, { candidate: cand, action }];
      decisionsRef.current = next;
      indexRef.current = i + 1;
      setDecisions(next);
      setIndex(i + 1);
      if (i + 1 >= candidates.length) {
        onComplete(next);
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
        onComplete(decisionsRef.current);
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
