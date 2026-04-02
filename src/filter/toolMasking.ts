const DEFAULT_TOKEN_THRESHOLD = 10_000;

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
