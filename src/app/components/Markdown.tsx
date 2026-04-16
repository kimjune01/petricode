import React from "react";
import { Text } from "ink";
import { colors } from "../theme.js";

/**
 * Minimal inline markdown renderer for Ink.
 * Handles: **bold**, `code`, *italic*
 * All output stays inside a single <Text> to satisfy Ink's constraints.
 */
export default function Markdown({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  // Match **bold**, `code`, *italic* — order matters (** before *)
  const re = /(\*\*(.+?)\*\*|`([^`]+)`|\*(.+?)\*)/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
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

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  if (parts.length === 0) {
    return <Text>{text}</Text>;
  }

  return <Text>{parts}</Text>;
}
