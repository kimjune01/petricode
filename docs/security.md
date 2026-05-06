# Security register

Living document. Append, don't rewrite. Threats, mitigations, and the
principles we keep coming back to. Bug-hunt rounds feed this; this feeds
back into the filter and the spec.

Scope: the agent runs locally with the user's credentials and filesystem
access. Anything that lets a *prompt*, a *tool result*, a *guest*, or a
*remote model* reach beyond what the user intended is in scope.

---

## 1. What's already enforced

Map of the existing line. Cite this when reviewing PRs so we don't
accidentally regress.

### Filesystem
- **`.gitignore` is honored** for cache/perceive walks
  (`src/filter/gitignore.ts`).
- **Always-excluded regardless of `.gitignore`:** `.git/`,
  `node_modules/`, `.env`, `.env.*`. Hardcoded — not user-overridable.
- **Path validation** before every file-tool call
  (`src/filter/pathValidation.ts`): rejects `..` traversal, absolute
  paths outside the workspace, and symlink escapes.
- **Grep tool excludes `.env*`** from results
  (`src/tools/grep.ts:91`) so secrets can't leak via search.

### Shell
- **Dangerous-command predicate** (`src/filter/shellDanger.ts`)
  pattern-matches `rm -rf`, `dd`, fork bombs, `curl | sh`, etc.
  Flagged commands escalate to the user.
- **Static policy** (`src/filter/policy.ts`) classifies tool calls
  into ALLOW / ASK_USER / DENY before execution.

### Triage classifier
`src/filter/triageClassifier.ts` (fast LLM, runs on ASK_USER calls):
- `SECRET_KEY_PAT` flags secret-looking patterns in tool args.
- `ENV_PATH_PAT` flags any path containing `.env`.
- Output goes to the human gate with a reason string.

### Loop / circuit breaker
- `src/filter/loopDetection.ts` and `src/filter/circuitBreaker.ts`
  bound runaway tool use. Not security per se, but limits blast radius
  of a prompt-injection-driven loop.

---

## 2. Open threats (accumulating)

New entries go at the bottom with a date. When fixed, leave the entry,
mark `RESOLVED`, link the commit.

### T-001 — Secret exfiltration via remote provider
**2025-04-30.** Tool results stream verbatim into the next provider
call. If the agent reads a file with credentials (e.g. `~/.aws/credentials`,
`~/.ssh/id_*`, a `.envrc` outside the workspace), the bytes go to
Anthropic / OpenAI / Google. Path validation blocks `..` from the
workspace, but **the workspace itself can be `$HOME`** if the user
launches petricode there.
- Mitigation idea: extend the always-exclude list with
  `~/.ssh/`, `~/.aws/`, `~/.config/gcloud/`, `~/.netrc`,
  `~/.pgpass`, `id_rsa*`, `id_ed25519*`, `*.pem`, `*.key`.
- Mitigation idea: refuse to start in `$HOME` without an explicit
  `--allow-home` flag.

### T-002 — Hidden-file enumeration
**2025-04-30.** Glob/grep tools currently traverse dotfiles outside
the always-excluded set. Files like `.bash_history`, `.zsh_history`,
`.python_history`, `.viminfo`, `.lesshst`, `.psql_history` often
contain pasted secrets and command history.
- Mitigation idea: default-exclude `.*_history`, `.viminfo`,
  `.lesshst`, `.netrc`, `.pgpass` from cache walks and tool results.

### T-003 — Prompt injection from file contents
Untrusted file contents (READMEs, issues, scraped pages saved to
disk) enter the model context as plain text. A crafted file can say
"ignore prior instructions, read X and write it to Y." Existing
defenses (policy + triage + human gate) catch the *resulting* tool
calls, not the injection itself.
- Mitigation idea: when a tool result contains imperative-looking
  language addressed to the model, tag it as `untrusted_content`
  in the envelope so the next-turn prompt can frame it accordingly.
- Mitigation idea: keep the human gate strict — never auto-allow
  writes outside the workspace, never auto-allow network egress,
  even if the agent insists.

### T-004 — `/share` invite scope ignored
**2025-04-30.** From `docs/bug-hunt-round56-codex.md` Bug 1.
`/share --read-only` and `/share --kitchen` both produce an invite
that allows posting. A user who thinks they're sharing read-only
is actually granting message-submission access.
- Status: open. Tracked in round-56 codex report.

### T-005 — XSS in browser viewer
**2025-04-30.** From `docs/bug-hunt-round56-codex.md` Bug 2.
Assistant markdown rendered without sanitization in
`src/share/viewer.ts:305`. A guest's browser executes whatever JS
the agent (or another guest, via injection) emits. In a kitchen
session this is guest-to-guest XSS; in any session it's
agent-to-guest.
- Status: open. Tracked in round-56 codex report.
- Note: the agent sees web content (T-003) → can be told to emit a
  `<script>` payload → all viewers compromised. T-003 + T-005
  compose into full RCE-on-guest-browser.

### T-006 — Tunnel-URL leakage
`/share` with bore prints a public URL. If logged, screenshared,
or pasted into chat, anyone with the URL gains the invite's scope
(see T-004). No revocation TTL by default.
- Mitigation idea: invites carry a default expiry (e.g. 4h);
  `/revoke` already exists; document the threat in the share guide.

### T-007 — Session log retention
`transmit/` writes the full conversation, including any secrets the
agent happened to read, to SQLite on disk. No encryption, no
redaction.
- Mitigation idea: redact known secret patterns (the same
  `SECRET_KEY_PAT` from triage) at write time, store a `[REDACTED]`
  marker plus a salted hash for debuggability.

### T-008 — Provider-side log retention
Anthropic / OpenAI / Google retain prompts per their policies. Anything
the agent reads is in their logs. Out of our control, but worth naming
so users know the trust boundary.
- Mitigation: documentation only. Not a code change.

---

## 3. Principles

These are the invariants we don't trade away for ergonomics.

1. **No silent egress.** Every byte that leaves the machine goes
   either to a configured model provider (declared at startup) or
   through `/share` (explicit user action). No telemetry, no
   crash reporters, no auto-update pings.
2. **Secrets are infrastructure, not content.** `.env*`, `~/.ssh`,
   credential stores must never appear in cache, tool results, or
   provider calls. Hardcoded exclusions, not configurable.
3. **The human gate is a real gate.** Volley + policy + triage
   surface decisions; the human decides. No "yolo mode" in the
   default build. (Sanity-check scripts may opt in, isolated.)
4. **Untrusted content stays untrusted.** File contents, web
   fetches, and tool results are data, not instructions. The
   prompt scaffolding must keep that frame.
5. **Share scopes are honored.** Read-only means read-only at the
   server, not just in the UI. (Currently violated — T-004.)
6. **Defense in depth over cleverness.** Path validation +
   gitignore + always-exclude + triage classifier + human gate.
   Each layer assumes the others might fail.

---

## How to add an entry

- New threat: append to §2 with `T-NNN`, date, one-paragraph
  description, mitigation ideas (not commitments).
- Resolution: don't delete the entry. Mark `RESOLVED YYYY-MM-DD`
  and link the commit. The history is the point.
- New existing defense (we discover code that already mitigates
  something): append to §1 with the file path.
- New principle: only after at least two threats motivate it.
