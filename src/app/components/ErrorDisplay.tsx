// ── Error display ───────────────────────────────────────────────
// User-friendly error messages, not stack traces.

import React from "react";
import { Box, Text } from "ink";
import { colors, spacing } from "../theme.js";

export type ErrorKind =
  | "provider"
  | "tool"
  | "parse"
  | "circuit_open"
  | "network"
  | "unknown";

export interface DisplayError {
  kind: ErrorKind;
  message: string;
  suggestion?: string;
}

function classify(error: string): DisplayError {
  const lower = error.toLowerCase();

  // Rate limiting
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("quota")) {
    return {
      kind: "provider",
      message: "Rate limited by provider.",
      suggestion: "Wait a moment and try again, or check your API quota.",
    };
  }

  // Auth errors
  if (lower.includes("401") || lower.includes("403") || lower.includes("api key") || lower.includes("unauthorized")) {
    return {
      kind: "provider",
      message: "Authentication failed.",
      suggestion: "Check your API key in petricode.config.json or environment variables.",
    };
  }

  // Server errors
  if (lower.includes("500") || lower.includes("502") || lower.includes("503")) {
    return {
      kind: "provider",
      message: "Provider server error.",
      suggestion: "This is temporary. Retry in a few seconds.",
    };
  }

  // Network errors
  if (lower.includes("fetch failed") || lower.includes("econnreset") || lower.includes("network") || lower.includes("timeout")) {
    return {
      kind: "network",
      message: "Network error.",
      suggestion: "Check your internet connection.",
    };
  }

  // Circuit breaker
  if (lower.includes("circuit") || lower.includes("all tiers")) {
    return {
      kind: "circuit_open",
      message: "All provider tiers are down.",
      suggestion: "Wait for cooldown or check provider status pages.",
    };
  }

  // Tool failures
  if (lower.includes("tool") || lower.includes("execute")) {
    return {
      kind: "tool",
      message: error,
      suggestion: "Check the tool arguments and try again.",
    };
  }

  // Parse errors
  if (lower.includes("parse") || lower.includes("json") || lower.includes("syntax")) {
    return {
      kind: "parse",
      message: "Response parsing failed.",
      suggestion: "Try again. If this persists, the model may be returning malformed output.",
    };
  }

  return {
    kind: "unknown",
    message: error,
    suggestion: "Try again. If this persists, check the crash log at .petricode/crash.log.",
  };
}

export function classifyError(error: string): DisplayError {
  return classify(error);
}

interface ErrorDisplayProps {
  error: string | null;
}

export default function ErrorDisplay({ error }: ErrorDisplayProps) {
  if (!error) return null;

  const classified = classify(error);

  return (
    <Box flexDirection="column" marginBottom={spacing.sm}>
      <Text color={colors.error} bold>
        !! {classified.kind === "unknown" ? "Error" : classified.kind}: {classified.message}
      </Text>
      {classified.suggestion && (
        <Text color={colors.hint}>
          → {classified.suggestion}
        </Text>
      )}
    </Box>
  );
}
