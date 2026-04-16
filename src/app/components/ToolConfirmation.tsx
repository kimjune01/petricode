import React, { useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";
import type { ToolCall } from "../../core/types.js";
import type { ConfirmMode } from "../../config/models.js";
import { colors, spacing } from "../theme.js";

const SHELL_PATTERNS = /shell|bash|command|run|exec|terminal|eval|system|script|process/i;
const FILE_PATTERNS = /file|edit|write|create|read|patch|replace|delete|remove/i;

type ToolKind = "shell" | "file" | "other";

function classifyTool(name: string): ToolKind {
  if (SHELL_PATTERNS.test(name)) return "shell";
  if (FILE_PATTERNS.test(name)) return "file";
  return "other";
}

interface ToolPreview {
  /** Primary preview: command string or file path */
  main: string;
  /** Optional secondary line: cwd for shell, content snippet for file writes */
  secondary?: string;
}

/** Extract the most useful preview from tool args. */
function toolPreview(kind: ToolKind, args: Record<string, unknown>): ToolPreview | null {
  if (kind === "shell") {
    const cmd = args.command ?? args.cmd ?? args.script ?? args.input;
    if (typeof cmd !== "string") return null;
    const cwd = args.cwd ?? args.dir ?? args.working_directory;
    return {
      main: cmd,
      secondary: typeof cwd === "string" ? `cwd: ${cwd}` : undefined,
    };
  }
  if (kind === "file") {
    const path = args.path ?? args.file_path ?? args.file ?? args.filename;
    if (typeof path !== "string") return null;
    // Surface write payloads so users can see what's being written
    const payload = args.content ?? args.text ?? args.new_string ?? args.old_string;
    let secondary: string | undefined;
    if (typeof payload === "string" && payload.length > 0) {
      const oneLine = payload.replace(/\n/g, "\\n");
      secondary = oneLine.length > 80 ? `${oneLine.slice(0, 80)}...` : oneLine;
    }
    return { main: path, secondary };
  }
  return null;
}

interface ToolConfirmationProps {
  toolCall: ToolCall;
  onConfirm: (allowed: boolean) => void;
  mode?: ConfirmMode;
}

export default function ToolConfirmation({
  toolCall,
  onConfirm,
  mode: _mode = "cautious",
}: ToolConfirmationProps) {
  const resolvedRef = useRef(false);

  // Reset the resolved flag when a new tool confirmation appears so the next
  // y/n/enter actually fires. Without this, a rapid second confirmation would
  // be ignored because resolvedRef is still true from the prior one.
  useEffect(() => {
    resolvedRef.current = false;
  }, [toolCall.id]);

  useInput((ch, key) => {
    if (resolvedRef.current) return;
    if (ch === "y" || ch === "Y") {
      resolvedRef.current = true;
      onConfirm(true);
    } else if (ch === "n" || ch === "N" || key.return) {
      // Enter defaults to deny — safer than auto-allow if a user hits it
      // by reflex, and matches the spec ("Enter without letter defaults
      // to safe action").
      resolvedRef.current = true;
      onConfirm(false);
    }
  });

  const kind = classifyTool(toolCall.name);
  const preview = toolPreview(kind, toolCall.args);
  const borderColor = kind === "shell" ? colors.error : colors.tool;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={borderColor} paddingX={spacing.sm}>
      <Text bold color={borderColor}>
        Tool confirmation required
      </Text>

      {/* Tool name with kind indicator */}
      <Text>
        {kind === "shell" ? (
          <Text bold color={colors.error}>⚠ Shell: </Text>
        ) : kind === "file" ? (
          <Text bold color={colors.muted}>File: </Text>
        ) : null}
        <Text bold>{toolCall.name}</Text>
      </Text>

      {/* Preview: command string or file path with context */}
      {preview != null && (
        <Box flexDirection="column" marginLeft={spacing.md}>
          {kind === "shell" ? (
            <>
              {preview.secondary && <Text dimColor>{preview.secondary}</Text>}
              <Text color={colors.error}>{preview.main}</Text>
            </>
          ) : (
            <>
              <Text>path: <Text color={colors.code}>{preview.main}</Text></Text>
              {preview.secondary && <Text dimColor>content: {preview.secondary}</Text>}
            </>
          )}
        </Box>
      )}

      {/* Fallback: truncated args when no structured preview available */}
      {preview == null && (
        <Text dimColor> {JSON.stringify(toolCall.args).slice(0, 120)}
          {JSON.stringify(toolCall.args).length > 120 ? " [...]" : ""}
        </Text>
      )}

      <Text>
        Allow? <Text bold color={colors.prompt}>✓ [y] allow</Text> / <Text bold color={colors.tool}>✗ [n] deny</Text>
        <Text color={colors.muted}>  (enter = deny)</Text>
      </Text>
    </Box>
  );
}
