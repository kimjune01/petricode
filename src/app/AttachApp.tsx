import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useApp } from "ink";
import type { Turn, Content } from "../core/types.js";
import type { ShareEvent } from "../share/events.js";
import { SSEClient, postMessage, parseShareURL } from "../share/client.js";
import MessageList from "./components/MessageList.js";
import Composer from "./components/Composer.js";
import StatusBar from "./components/StatusBar.js";
import { spacing } from "./theme.js";

export interface AttachAppProps {
  url: string;
}

type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

function shareEventToTurn(event: ShareEvent): Turn | null {
  switch (event.type) {
    case "message.user":
    case "message.queued": {
      const text = (event.payload as { text?: string }).text ?? "";
      const prefix = event.actor === "host" ? "" : `[${event.actor}] `;
      return {
        id: event.id,
        role: "user",
        content: [{ type: "text", text: prefix + text }],
        timestamp: new Date(event.ts).getTime(),
      };
    }
    case "message.assistant": {
      const text = (event.payload as { text?: string }).text ?? "";
      return {
        id: event.id,
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: new Date(event.ts).getTime(),
      };
    }
    case "tool.request": {
      const { name, args } = event.payload as { name: string; args: unknown };
      return {
        id: event.id,
        role: "assistant",
        content: [{ type: "text", text: `[tool] ${name}` }],
        timestamp: new Date(event.ts).getTime(),
      };
    }
    case "tool.result": {
      const { name, result } = event.payload as { name: string; result: string };
      const truncated = result && result.length > 200 ? result.slice(0, 200) + "…" : result;
      return {
        id: event.id,
        role: "system",
        content: [{ type: "text", text: `[${name}] ${truncated ?? ""}` }],
        timestamp: new Date(event.ts).getTime(),
      };
    }
    default:
      return null;
  }
}

export default function AttachApp({ url }: AttachAppProps) {
  const { exit } = useApp();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [scope, setScope] = useState<"living" | "kitchen">("living");
  const [clearCount, setClearCount] = useState(0);
  const clientRef = useRef<SSEClient | null>(null);
  const localEchoRef = useRef<Set<string>>(new Set());

  const parsed = parseShareURL(url);

  useEffect(() => {
    if (!parsed) return;

    const client = new SSEClient({
      url: `${parsed.host}/sessions/${parsed.sessionId}/events`,
      token: parsed.token,
      onEvent: (event: ShareEvent) => {
        if (event.type === "message.chunk") {
          const text = (event.payload as { text: string }).text;
          setStreamingText((prev) => prev + text);
          return;
        }

        if (event.type === "turn.complete") {
          setStreamingText("");
          return;
        }

        // Reconcile local echo
        if (event.type === "message.queued" && event.txn_id && localEchoRef.current.has(event.txn_id)) {
          return;
        }
        if (event.type === "message.user" && event.txn_id && localEchoRef.current.has(event.txn_id)) {
          localEchoRef.current.delete(event.txn_id);
          // Replace the queued turn with the confirmed one
          const turn = shareEventToTurn(event);
          if (turn) {
            setTurns((prev) => {
              const idx = prev.findIndex((t) => t.id.startsWith("local-") && event.txn_id && t.id.includes(event.txn_id));
              if (idx >= 0) {
                const updated = [...prev];
                updated[idx] = turn;
                return updated;
              }
              return [...prev, turn];
            });
          }
          return;
        }

        if (event.type === "message.assistant") {
          setStreamingText("");
        }

        const turn = shareEventToTurn(event);
        if (turn) {
          setTurns((prev) => [...prev, turn]);
        }
      },
      onConnect: () => setStatus("connected"),
      onDisconnect: () => setStatus("reconnecting"),
      watchdogMs: 20_000,
    });

    clientRef.current = client;
    client.connect().catch(() => setStatus("disconnected"));

    return () => {
      client.disconnect();
    };
  }, [url]);

  useEffect(() => {
    if (!parsed) return;
    let cancelled = false;
    setScope("living");
    fetch(`${parsed.host}/sessions/${parsed.sessionId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${parsed.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    }).then((resp) => {
      if (!cancelled && resp.status === 400) setScope("kitchen");
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [url]);

  const handleSubmit = useCallback(async (input: string) => {
    if (!parsed || scope !== "kitchen") return;

    const txn_id = crypto.randomUUID();
    localEchoRef.current.add(txn_id);

    // Show local echo immediately
    const echoTurn: Turn = {
      id: `local-${txn_id}`,
      role: "user",
      content: [{ type: "text", text: `[you] ${input}` }],
      timestamp: Date.now(),
    };
    setTurns((prev) => [...prev, echoTurn]);

    try {
      await postMessage(parsed.host, parsed.sessionId, parsed.token, input, txn_id);
    } catch {
      localEchoRef.current.delete(txn_id);
      setTurns((prev) => prev.filter((t) => t.id !== `local-${txn_id}`));
      setTurns((prev) => [...prev, {
        id: crypto.randomUUID(),
        role: "system",
        content: [{ type: "text", text: "[error] Failed to send message" }],
        timestamp: Date.now(),
      }]);
    }
  }, [parsed, scope]);

  if (!parsed) {
    return (
      <Box padding={spacing.sm}>
        <Text color="red">Invalid share URL: {url}</Text>
      </Box>
    );
  }

  const isKitchen = scope === "kitchen";
  const statusLabel = status === "connected" ? "connected" : status === "reconnecting" ? "reconnecting..." : status;

  return (
    <Box flexDirection="column" padding={spacing.sm}>
      <Text bold>🧫 petricode <Text dimColor>(attached — {statusLabel})</Text></Text>
      <Box flexDirection="column" flexGrow={1} marginY={spacing.sm}>
        <MessageList turns={turns} phase={status === "connected" ? "composing" : "running"} streamingText={streamingText} />
      </Box>

      {isKitchen && (
        <Composer
          onSubmit={handleSubmit}
          disabled={status !== "connected"}
          clearSignal={clearCount}
          phase={status === "connected" ? "composing" : "running"}
          onEofExit={exit}
        />
      )}
      <Box>
        <Text dimColor>
          {isKitchen ? "kitchen" : "living room"} · {parsed.sessionId.slice(0, 8)}
        </Text>
      </Box>
    </Box>
  );
}
