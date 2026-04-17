import { useState, useEffect } from "react";

// Science-themed rotation. All glyphs are U+1F9** / U+1F52C — modern
// terminals render them at a consistent 2-column width, so the line
// doesn't jitter between frames. Avoiding ⚗️ on purpose: it carries a
// variation selector and renders 1-column in some terminals.
export const SPINNER = ["🧪", "🧫", "🦠", "🧬", "🔬"];
export const SPINNER_INTERVAL_MS = 220;

export function useSpinner(active: boolean): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) {
      // Reset so the next activation starts at frame 0 instead of
      // resuming where the last spin left off.
      setFrame(0);
      return;
    }
    const timer = setInterval(
      () => setFrame((f) => (f + 1) % SPINNER.length),
      SPINNER_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, [active]);
  return active ? SPINNER[frame]! : "";
}
