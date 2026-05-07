# Bug Hunt Round 58 (gemini-3-pro-preview)

Model: gemini-3-pro-preview. Scope: rendering bugs across all of src/app/ + src/share/{viewer,ansi,client}.ts. Pure code review, no execution. ~3017 lines / 103 KB input.

---

## Summary

The core rendering architecture successfully avoids $O(n^2)$ repaints during streaming via a clever memoized `Markdown` implementation, but the strict `<Static>` boundary and unmanaged state lifecycles cause significant visual bugs. The most severe issues involve XSS in the browser-based share viewer, persistent ghost-text duplication in the TUI stream renderer, and incomplete ANSI sanitization during bracketed pastes and tool confirmations that could allow terminal spoofing. 

## Critical

### Finding 1: Share viewer XSS via unsanitized markdown
**File:** `src/share/viewer.ts:167` and `186`
**What:** The viewer passes incoming assistant chunks directly into `marked.parse()` and assigns the result to `.innerHTML` without any HTML escaping.
**Why it matters:** An LLM returning malicious HTML (e.g., `<img src="x" onerror="alert(1)">` or script tags) will execute arbitrary JavaScript in the browser of anyone viewing the share link.
**Fix sketch:** Configure `marked` with an extension to escape raw HTML, or pipe the output through DOMPurify before setting `innerHTML`.

## High

### Finding 2: Ghost streaming text duplicates permanently
**File:** `src/app/App.tsx:64`
**What:** `stopStreamThrottle` explicitly assigns the final `streamBufRef` content to `streamingText` instead of clearing it to `""`.
**Why it matters:** Because `MessageList` renders both the completed `turns` list and `streamingText` concurrently, every finalized LLM response duplicates on the screen perpetually below the chat history until the next turn begins.
**Fix sketch:** Update `stopStreamThrottle` to call `setStreamingText("")` so the dynamic tail disappears once the finalized static turn is appended.

### Finding 3: Bracketed paste injects raw ANSI escapes
**File:** `src/app/components/Composer.tsx:178`
**What:** While trailing and preceding keyboard inputs are sanitized using `.replace(STRIP_TERM_CTRL, "")`, the actual bracketed paste payload (`combined += pasteBuffer.substring(0, endIdx)`) bypasses the stripper completely.
**Why it matters:** Pasting content containing terminal escape codes (like `\x1b[2J`) will literally output to the terminal, allowing layout destruction, screen clearing, or color-bleed directly inside the composer.
**Fix sketch:** Sanitize the payload during extraction: `combined += pasteBuffer.substring(0, endIdx).replace(STRIP_TERM_CTRL, "");`.

### Finding 4: `<Static>` boundary breaks AttachApp local echo reconciliation
**File:** `src/app/components/MessageList.tsx:60-62`
**What:** `MessageList` passes the entire `turns` array into Ink's `<Static>` component, which only appends new items and strictly ignores mutations to existing elements.
**Why it matters:** When `AttachApp` receives server confirmation for a local message and mutates the placeholder `[you]` turn (line 82), the `<Static>` list ignores the update, leaving the UI permanently desynced from the network state.
**Fix sketch:** Maintain unconfirmed or mutating turns (like local echo) outside the `<Static>` list, shifting them into `Static` only once they fully settle.

## Medium

### Finding 5: Unsanitized ANSI in tool confirmation preview
**File:** `src/app/components/ToolConfirmation.tsx:136-138`
**What:** Unlike the classifier rationale which runs through `stripAnsi`, the `preview.main` and `preview.secondary` strings (which contain LLM-generated shell commands or file paths) are rendered directly into `<Text>` components.
**Why it matters:** A rogue LLM can include terminal escapes in a tool call argument (e.g. `\x1b[31m rm -rf \x1b[0m`) to visually spoof the TUI confirmation prompt or hide the actual command before approval.
**Fix sketch:** Apply `stripAnsi()` to both `preview.main` and `preview.secondary` prior to rendering them.

### Finding 6: Duplicate rendering of network/pipeline errors
**File:** `src/app/App.tsx:432-435`
**What:** The pipeline `catch` block both appends a `failedTurn` to the static chat history AND sets `state.error` with the exact same error message.
**Why it matters:** Any network failure or rate limit renders twice simultaneously on the user's screen (once in the `MessageList` history, and again in the persistent `ErrorDisplay` banner below).
**Fix sketch:** Avoid appending an explicit `failedTurn` to the timeline for system errors, relying solely on `ErrorDisplay` for transient runtime issues.

### Finding 7: Dead `ToolGroup` spinner animation
**File:** `src/app/components/ToolGroup.tsx:10-18`
**What:** `ToolGroup` implements an 80ms spinner when `hasResult === false`, but `App.tsx` only passes fully resolved turns containing finalized `tool_calls` down into `MessageList` and the `<Static>` wrapper.
**Why it matters:** The intended UX of showing a spinning, executing tool in the chat history is unreachable. Tools execute invisibly and only appear visually once they are fully resolved.
**Fix sketch:** Surface in-flight tools to the UI state and render them in `MessageList` below the `<Static>` boundary until they complete.

### Finding 8: Share viewer duplicate queued messages
**File:** `src/share/viewer.ts:223` and `245`
**What:** `viewer.html` optimistically appends a `queued` turn on form submit but lacks logic to filter the subsequent `message.queued` SSE broadcast using `txn_id`.
**Why it matters:** Whenever a guest sends a message, they see multiple identical "queued" bubbles stack up in their UI, cluttering the view until the host eventually confirms the message.
**Fix sketch:** Maintain a local `Set` of sent `txn_id`s in the viewer script and drop any incoming `message.queued` events that match an active local transaction.

## Low

### Finding 9: `Ctrl+W` in Composer fails on whitespace-only input
**File:** `src/app/components/Composer.tsx:288`
**What:** The backward-delete-word logic uses `before.replace(/\S+\s*$/, "")`, which strictly requires at least one non-whitespace character (`\S+`).
**Why it matters:** If the user presses `Ctrl+W` when the input is entirely spaces or they are parked on a block of trailing whitespace (e.g. `"   "`), the command becomes a silent no-op instead of deleting the space block.
**Fix sketch:** Update the regex to allow deletion of trailing space blocks: `/(?:\S+\s*|\s+)$/`.

### Finding 10: Naive UTF-16 slicing truncates surrogate pairs
**File:** `src/app/components/ToolGroup.tsx:16` (also `AttachApp.tsx:41`, `ansi.ts:38`)
**What:** Tool previews aggressively truncate strings using standard `String.prototype.slice(0, N)`.
**Why it matters:** Standard `slice` splits by UTF-16 code units. If an emoji or CJK character lands exactly on the slice boundary, it yields a dangling surrogate that renders as an invalid character block (``).
**Fix sketch:** Use `Array.from(string).slice(0, N).join('')` or an `Intl.Segmenter` helper to safely truncate by grapheme clusters/code points.

### Finding 11: AttachApp downgrades tools to generic text
**File:** `src/app/AttachApp.tsx:34-39`
**What:** `AttachApp` maps `tool.request` SSE events to plain `[tool] name` text content, rather than populating the `turn.tool_calls` array.
**Why it matters:** Guest viewers see tools rendered as standard assistant chat bubbles rather than the structured `ToolGroup` UI that the host sees, creating a confusing visual discrepancy.
**Fix sketch:** Map the SSE events to a synthetic turn containing `tool_calls: [{ id, name, args }]` so `MessageList` can render them natively.
