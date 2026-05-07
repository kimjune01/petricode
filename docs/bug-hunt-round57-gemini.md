# Bug Hunt Round 57 (gemini-flash)

Model: gemini-2.5-flash. Focus: TUI rendering bugs in src/app/ and src/share/{viewer,ansi,client}.ts. Pure code review (no tools).

Here's a bug-hunt report for rendering bugs in the petricode terminal UI:

### Finding 1: Stale `stateRef` in Composer on `internal_eventEmitter` paste
- **File:** src/app/components/Composer.tsx:181
- **Severity:** critical
- **Symptom:** When pasting large amounts of text via bracketed paste, subsequent keypresses or pastes in the same `internal_eventEmitter` "input" event might operate on a stale `stateRef.current` because `setRenderState` (which updates `stateRef.current`) is async. This can lead to incorrect input concatenation, cursor position, or even loss of parts of the pasted content.
- **Cause:** `updateState` updates `stateRef.current` synchronously but `setRenderState` (which causes a re-render and propagates the new state to `renderState` and subsequent `stateRef.current` reads *after* the render) is asynchronous. The `onRawInput` listener closes over `stateRef.current` from the previous render, leading to a race condition if multiple `input` events fire before a re-render completes.
- **Repro:**
    1. Paste a very long string into the composer.
    2. Immediately paste another string or type characters before the UI has fully updated from the first paste.
    3. Observe jumbled or missing input.
- **Fix sketch:** Ensure `onRawInput` always operates on the absolute latest input state, possibly by passing the current `input` and `cursor` as arguments to `onRawInput` or by using a reducer with a synchronous dispatch mechanism that ensures the internal state is updated immediately.

### Finding 2: `streamingText` in `App.tsx` not cleared on non-streaming turn completion
- **File:** src/app/App.tsx:392, 492
- **Severity:** high
- **Symptom:** If a turn completes without `onText` ever being called (e.g., a tool-only turn or a very fast text turn), `streamingText` might not be explicitly cleared, leading to the last streamed content lingering on screen even after the turn is complete and moved to `turns`.
- **Cause:** `stopStreamThrottle()` is called only if `onText` was invoked. `streamBufRef.current` is cleared, but `setStreamingText(streamBufRef.current)` is called, which would update `streamingText` to an empty string. However, if no streaming occurred, `startStreamThrottle` was never called, and `streamingText` might retain its previous value. The `turn.complete` event handler in `AttachApp.tsx` explicitly clears `streamingText`.
- **Repro:**
    1. Trigger an agent turn that *only* calls tools and outputs no text, or outputs text extremely fast (e.g., one short `onText` call followed immediately by completion).
    2. Observe the previous `streamingText` (if any) remaining on screen below the last settled turn.
- **Fix sketch:** In `handleSubmit` and the guest message queue `useEffect`, ensure `setStreamingText("")` is called after a pipeline turn, regardless of whether `stopStreamThrottle` was invoked.

### Finding 3: `AttachApp` potentially displaying stale `streamingText` if server sends `turn.complete` late
- **File:** src/app/AttachApp.tsx:82
- **Severity:** high
- **Symptom:** The `SSEClient`'s `onEvent` for `message.assistant` immediately sets `streamingText("")`. However, `message.assistant` events represent the *final* text for a turn, and `message.chunk` events precede it. If the server sends `message.assistant` *before* all `message.chunk` events have been processed, or if a `turn.complete` event is delayed after the final chunk, the `streamingText` could be prematurely cleared, leading to incomplete display of streamed content, or cleared and then re-populated by a delayed chunk.
- **Cause:** `message.assistant` handler clears `streamingText` unconditionally. The `message.chunk` handler sets `streamingText`. The `turn.complete` handler also clears `streamingText`. The order of these events from the server and their processing can lead to a visual glitch.
- **Repro:**
    1. Connect `AttachApp` to a share session.
    2. Have the host generate a long streamed response.
    3. Introduce an artificial delay in the server sending the `turn.complete` event after all `message.chunk` events, or send `message.assistant` prematurely.
    4. Observe `streamingText` flickering or appearing incomplete.
- **Fix sketch:** Ensure `streamingText` is only cleared *after* all `message.chunk` events have been received and processed for a given turn, ideally triggered by `turn.complete`. The `message.assistant` handler should perhaps only set the final content in `turns` and rely on `turn.complete` to clear `streamingText`.

### Finding 4: Inconsistent `AbortError` handling for `confirmResolveRef`
- **File:** src/app/App.tsx:143
- **Severity:** medium
- **Symptom:** The `useEffect` cleanup for `App.tsx` rejects `confirmResolveRef.current` with `DOMException("Aborted", "AbortError")`. However, the Ctrl+C handler (line 198) also rejects it with the same error type. This redundancy could be a minor issue but also points to slightly different ways of handling the same state transition.
- **Cause:** Duplicate logic for rejecting `confirmResolveRef` with an `AbortError`.
- **Repro:**
    1. Enter a confirmation prompt.
    2. Unmount the `App` component (e.g., navigate away if it were part of a larger app, or force an unmount).
    3. Trigger Ctrl+C during a confirmation prompt.
    4. Both paths perform the same action, which is harmless, but could be cleaner.
- **Fix sketch:** Consolidate the `confirmResolveRef` rejection logic into a single, reusable function or effect to ensure consistent behavior and avoid duplication.

### Finding 5: `AttachApp` local echo not removed on successful `message.user` if `event.txn_id` is missing
- **File:** src/app/AttachApp.tsx:90
- **Severity:** low
- **Symptom:** The logic to remove local echo relies on `event.txn_id` being present in both the `message.queued` and `message.user` events. If for some reason the `txn_id` is missing from the `message.user` event, the local echo turn will not be removed and replaced, leading to duplicated user messages in the `AttachApp` UI.
- **Cause:** The `if (event.type === "message.user" && event.txn_id && localEchoRef.current.has(event.txn_id))` condition could fail if `event.txn_id` is null or undefined for the `message.user` event.
- **Repro:**
    1. Send a message from the `AttachApp` client.
    2. Have the server *intentionally omit* `txn_id` from the `message.user` event.
    3. Observe a duplicated user message in the `AttachApp` UI (one queued, one confirmed).
- **Fix sketch:** Add a fallback mechanism or an assertion that `txn_id` is always present for `message.user` events that correspond to local echoes. Alternatively, consider using a more robust identifier for reconciliation.

### Finding 6: `Composer` `onRawInput` can cause `internal_eventEmitter` to fire synchronously
- **File:** src/app/components/Composer.tsx:298
- **Severity:** medium
- **Symptom:** The `process.nextTick` used to reset `isPasting.current` might not prevent `useInput` from firing its listener synchronously within the *same* stdin chunk processing. If `useInput`'s listener is processed before `process.nextTick` runs, it could still see `isPasting.current` as `false` and process duplicate keypresses for characters that were part of a paste or typed after a paste.
- **Cause:** `process.nextTick` schedules a callback for the *next* turn of the event loop, not necessarily before other synchronous handlers for the *current* event loop turn. Ink's `useInput` listener might run synchronously after `onRawInput` within the same `input` event.
- **Repro:**
    1. Paste a short string.
    2. Immediately type a character.
    3. Observe occasional duplication of the typed character or misbehavior due to `isPasting.current` being reset too late.
- **Fix sketch:** Ensure a more robust synchronous mechanism for muting `useInput`'s listener within the same event loop tick. Perhaps `useInput` itself needs to be aware of the raw input processing state. A `setTimeout(..., 0)` or `queueMicrotask` might be more reliable but still not fully synchronous within the current tick.

### Finding 7: Hardcoded `slice` limits for JSON args in `ToolGroup` and `ToolConfirmation`
- **File:** src/app/components/ToolGroup.tsx:18, src/app/components/ToolConfirmation.tsx:156
- **Severity:** low
- **Symptom:** The `JSON.stringify(toolCall.args).slice(0, 60)` in `ToolGroup` and similar fixed-length slicing in `ToolConfirmation` might truncate args too aggressively or not enough, leading to unhelpful previews or excessive output for very short args. This is a layout concern, as it implicitly assumes a certain character width.
- **Cause:** Fixed-length slicing without considering actual terminal width or content significance.
- **Repro:**
    1. Execute a tool call with very short arguments (e.g., `{"foo": "bar"}`). The preview might look fine but could be made more concise.
    2. Execute a tool call with moderately long arguments (e.g., a JSON string that's 70 characters long). The preview will be truncated.
- **Fix sketch:** Consider a more dynamic truncation based on available terminal width (if accessible via Ink) or a more intelligent summarization of JSON objects, especially for deeply nested or large objects, rather than a naive character slice.

### Finding 8: `Markdown` component's `INLINE_RE` regex for inline code styling might not handle multi-line inputs correctly
- **File:** src/app/components/Markdown.tsx:16
- **Severity:** low
- **Symptom:** The `INLINE_RE` regex uses `[^\n]+?` for matching inline markdown elements like `**bold**`, `` `code` `` and `*italic*`. While this prevents spanning across newlines for *a single match*, if an inline code block or bold text *contains* a newline (which shouldn't happen in strict markdown but could occur with malformed input or if the `text` is already split in an unexpected way), the `MarkdownLine` component will render it incorrectly. Ink's `Text` component generally handles newlines by breaking the line.
- **Cause:** The regex explicitly excludes newlines, which is correct for markdown spec, but the `MarkdownLine` is designed to operate on single lines. If a "line" passed to `MarkdownLine` somehow contains a newline, the regex will treat it as termination of the inline element.
- **Repro:**
    1. Pass `text="This has **bold\ntext**"` to the `Markdown` component.
    2. Observe the bold text being incorrectly rendered or truncated.
- **Fix sketch:** Ensure that `MarkdownLine` *always* receives single-line strings by making the `text.split("\n")` more robust, or by explicitly handling newlines within the regex and Ink's Text component. Given the current `split("\n")` logic, this is likely a non-issue unless `text` contains unescaped newlines which would then create multiple `MarkdownLine` components. However, it's good to be aware of the regex limitation.

### Finding 9: `AttachApp` `shareEventToTurn` for `tool.request` lacks args preview
- **File:** src/app/AttachApp.tsx:50
- **Severity:** nit
- **Symptom:** The `shareEventToTurn` function for `tool.request` events in `AttachApp` only displays the tool name, not its arguments. This makes it harder for a guest user to understand what parameters the tool is being invoked with, reducing transparency compared to the host UI's `ToolGroup`.
- **Cause:** The `content` for `tool.request` is hardcoded to `[{ type: "text", text: [tool] ${name} }]`.
- **Repro:**
    1. Connect `AttachApp` to a share session.
    2. Have the host execute a tool with arguments.
    3. Observe that the guest UI only shows `[tool] <tool_name>` without arguments.
- **Fix sketch:** Modify `shareEventToTurn` to include a truncated JSON representation of `event.payload.args` for `tool.request` events, similar to how `ToolGroup` does it.

### Summary

The most worrying class of bugs involves **Stale state** and **Tearing/race conditions**, particularly in the `Composer` component's paste handling (`isPasting` state and `stateRef` synchronization) and `App.tsx`'s `streamingText` management. These can directly lead to data loss or incorrect information being displayed to the user. The `AttachApp` also has a related issue with `streamingText` clearing. Other findings are lower severity, mostly concerning inconsistent rendering details, truncation, or minor UX improvements.
