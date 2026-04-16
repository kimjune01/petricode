import React, { useMemo } from "react";
import { Text } from "ink";
import { colors } from "../theme.js";

/**
 * Minimal inline markdown renderer for Ink.
 * Handles: **bold**, `code`, *italic*
 *
 * Splits text into lines so that during streaming only the last
 * (actively growing) line re-parses — completed lines are memoized.
 * This keeps rendering O(n) instead of O(n^2) over the full response.
 */

// Restrict `.+?` to `[^\n]+?` so unclosed tags don't scan across lines
const INLINE_RE = /(\*\*([^\n]+?)\*\*|`([^`\n]+)`|\*([^\n]+?)\*)/g;

const MarkdownLine = React.memo(function MarkdownLine({ line }: { line: string }) {
  if (!line) return null;

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  INLINE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = INLINE_RE.exec(line)) !== null) {
    if (match.index > lastIndex) {
      parts.push(line.slice(lastIndex, match.index));
    }

    if (match[2] !== undefined) {
      parts.push(<Text key={match.index} bold>{match[2]}</Text>);
    } else if (match[3] !== undefined) {
      parts.push(<Text key={match.index} color={colors.code}>{match[3]}</Text>);
    } else if (match[4] !== undefined) {
      parts.push(<Text key={match.index} italic>{match[4]}</Text>);
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < line.length) {
    parts.push(line.slice(lastIndex));
  }

  return <Text>{parts.length === 0 ? line : parts}</Text>;
});

function Markdown({ text }: { text: string }) {
  const lines = useMemo(() => text.split("\n"), [text]);

  if (lines.length === 1) {
    return <MarkdownLine line={lines[0]!} />;
  }

  return (
    <Text>
      {lines.map((line, i) => (
        <React.Fragment key={i}>
          <MarkdownLine line={line} />
          {i < lines.length - 1 ? "\n" : null}
        </React.Fragment>
      ))}
    </Text>
  );
}

export default React.memo(Markdown);
