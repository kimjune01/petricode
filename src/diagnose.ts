export function diagnose(err: unknown): { cause: string; fix: string } | null {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  if (lower.includes("openai_api_key")) {
    const gac = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const vertexHint = gac
      ? `\n  Vertex AI credentials found at ${gac} — configure tiers to use google/anthropic providers instead`
      : "\n  or use Vertex AI: export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json";
    return {
      cause: "OpenAI API key not found",
      fix: `export OPENAI_API_KEY=sk-... in your shell profile${vertexHint}`,
    };
  }
  if ((lower.includes("anthropic") || lower.includes("x-api-key")) && lower.includes("api key")) {
    return {
      cause: "Anthropic API key not found",
      fix: "export ANTHROPIC_API_KEY=sk-ant-... in your shell profile",
    };
  }
  if (lower.includes("google_api_key") || lower.includes("google_application_credentials") || lower.includes("default credentials")) {
    return {
      cause: "Google credentials not found",
      fix: "export GOOGLE_API_KEY=... or run: gcloud auth application-default login",
    };
  }
  if (lower.includes("missing credentials")) {
    return {
      cause: "API credentials not found",
      fix: "set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY in your shell profile",
    };
  }
  if (lower.includes("eaddrinuse")) {
    const port = msg.match(/port (\d+)/i)?.[1] ?? "";
    return {
      cause: `Port ${port} already in use`,
      fix: "another petricode may be running — kill it, or use --share-host host:port",
    };
  }
  if (lower.includes("unknown provider")) {
    return {
      cause: "Unknown provider in config",
      fix: "check tiers in petricode.config.json — valid providers: anthropic, openai, google",
    };
  }
  if (lower.includes("eacces") || lower.includes("permission denied")) {
    return {
      cause: "Permission denied",
      fix: "check file permissions on .petricode/ directory",
    };
  }
  if (lower.includes("database") && (lower.includes("locked") || lower.includes("readonly") || lower.includes("busy"))) {
    return {
      cause: "SQLite database locked or read-only",
      fix: "another petricode may have the database open — close it, or check .petricode/data/ permissions",
    };
  }
  if (lower.includes("getaddrinfo") || lower.includes("enotfound") || lower.includes("econnrefused")) {
    return {
      cause: "Network error — cannot reach API",
      fix: "check your internet connection and DNS",
    };
  }
  if (lower.includes("fetch failed") || lower.includes("econnreset") || lower.includes("timeout")) {
    return {
      cause: "Network request failed",
      fix: "check your internet connection. If on VPN, ensure API endpoints are reachable",
    };
  }
  return null;
}
