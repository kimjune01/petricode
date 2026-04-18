// Threshold must clear ReadFileTool's MAX_READ_BYTES (256KB ≈ 64K tokens)
// plus the truncation marker — otherwise readFile's deliberate "truncated
// head + actionable suffix" is wiped to an opaque `[masked]` blob the
// model can't act on. Shell/grep cap at 1MB (~250K tokens) and *should*
// still trip masking when they overflow; that's intentional.
const DEFAULT_TOKEN_THRESHOLD = 65_000;

export interface MaskResult {
  content: string;
  masked: boolean;
}

/**
 * Replace oversized tool output with a placeholder.
 * Token estimate: chars / 4.
 */
export function maskToolOutput(
  output: string,
  threshold: number = DEFAULT_TOKEN_THRESHOLD,
): MaskResult {
  const estimatedTokens = Math.ceil(output.length / 4);
  if (estimatedTokens > threshold) {
    return {
      content: `[masked — ${estimatedTokens} tokens]`,
      masked: true,
    };
  }
  return { content: output, masked: false };
}
