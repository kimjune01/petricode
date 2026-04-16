# Bug Hunt Findings - Round 1

## 1. Integration Seam — Missing TUI wire-up for tool confirmation
- **File:** `src/agent/pipeline.ts` & `src/app/App.tsx`
- **Line:** Pipeline declares `private onConfirm?: ConfirmFn;` but never exposes it.
- **Description:** The TUI confirmation UI (`ToolConfirmation.tsx`) is never triggered because the `onConfirm` callback passed in `bootstrap.ts` is hardcoded to return `true`. Meanwhile, `App.tsx` has all the state logic (`confirmResolveRef`) but no way to inject it into the pipeline since the property is `private`.
- **Impact:** Irreversible tools are executed immediately without user confirmation, defeating the safety harness.
- **Suggested Fix:** Make `onConfirm` public (`public onConfirm?: ConfirmFn;`) in `pipeline.ts`. In `App.tsx`'s `useEffect`, wire it up: `pipeline.onConfirm = (toolCall) => new Promise((resolve) => { confirmResolveRef.current = resolve; setState(...) })`. Remove the dummy handler from `bootstrap.ts`.

## 2. State Machine Violation — Circuit Breaker half-open state thundering herd
- **File:** `src/filter/circuitBreaker.ts`
- **Line:** `if (circuit.state === "half-open") { circuit.state = "open"; return true; }`
- **Description:** When the circuit is `half-open` (a probe is already in flight), concurrent callers will see `half-open`, but the code mistakenly returns `true` and resets the state to `open`. This allows a second concurrent probe to slip through. Worse, because `lastFailure` wasn't updated, a third caller will see `open`, check the cooldown (which still passes), set it back to `half-open`, and return `true`.
- **Impact:** Concurrent requests completely bypass the circuit breaker while it is testing a failing service, exacerbating load on a degraded provider.
- **Suggested Fix:** If `circuit.state === "half-open"`, simply `return false;`. The first caller who claimed the probe is already handling it.

## 3. Logic Bug — TfIdfIndex array splicing shifts indices
- **File:** `src/cache/tfidf.ts`
- **Line:** `this.documents.splice(index, 1);` in `remove_document`.
- **Description:** Splicing the `documents` array removes the element and shifts all subsequent elements down by 1. Since external data structures reference documents by their absolute array index, this silently invalidates all index references past the removed document.
- **Impact:** Cache eviction corrupts the TF-IDF search index, leading to incorrect similarity matches or out-of-bounds errors.
- **Suggested Fix:** Replace the document with an empty string tombstone (`this.documents[index] = "";`) instead of using `splice` to preserve index stability.

## 4. Edge Case — Abort during tool confirmation ignores pipeline
- **File:** `src/app/App.tsx`
- **Line:** `if (state.phase === "running" && abortRef.current)` in `useInput`.
- **Description:** Pressing Ctrl+C while the app is in the `"confirming"` phase ignores the abort request because it specifically checks for `"running"`.
- **Impact:** The user cannot cleanly interrupt a pipeline that is paused waiting for tool confirmation without fully exiting the app or resolving the confirmation first.
- **Suggested Fix:** Change the condition to `if ((state.phase === "running" || state.phase === "confirming") && abortRef.current)`. Additionally, invoke `confirmResolveRef.current(false)` to unblock the pipeline so it can throw the `AbortError`.

## 5. Resource Cleanup — Rapid Ctrl+C timer leak
- **File:** `src/app/App.tsx`
- **Line:** `setTimeout(() => setCtrlCPending(false), 1000);` in `useInput`.
- **Description:** The 1-second timeout used to reset the `ctrlCPending` state is never cleared. If a user presses a different key, or presses Ctrl+C again after 500ms, the previous timeout will still fire at 1000ms and prematurely clear the pending state.
- **Impact:** Rapidly pressing Ctrl+C or mixing keys can cause the double-tap exit mechanism to fail or behave inconsistently.
- **Suggested Fix:** Store the timer in a `useRef<NodeJS.Timeout>`. Call `clearTimeout` before starting a new timer and when cancelling the pending state.

## 6. Resource Cleanup — AbortController leak on unmount (Process hang)
- **File:** `src/app/App.tsx`
- **Line:** `const controller = new AbortController(); abortRef.current = controller;` in `handleSubmit`.
- **Description:** When the app exits while a pipeline turn is running (e.g. user triggers double Ctrl+C exit), the React component unmounts but the in-flight `AbortController` is never aborted.
- **Impact:** The Ink UI unmounts and returns to the terminal prompt, but the Node process hangs in the background waiting for the API network request to resolve.
- **Suggested Fix:** Add a `useEffect` cleanup function that calls `abortRef.current?.abort()` when the `App` component unmounts.

## 7. React/Ink Bug — Double submit race condition & stale closure in Composer
- **File:** `src/app/components/Composer.tsx` and `src/app/App.tsx`
- **Line:** `if (key.return) { ... onSubmit(trimmed); setInput(""); }`
- **Description:** `Composer.tsx` does not use functional state updates for `setInput`, meaning rapid inputs (like pasting text) use stale closure state. Additionally, `App.tsx` does not guard `handleSubmit` against concurrent calls. If the user mashes Enter, `onSubmit` fires multiple times before React can asynchronously set `disabled=true`.
- **Impact:** A single user action can launch multiple concurrent pipeline turns, duplicating data, thrashing the API, and corrupting the chat history.
- **Suggested Fix:** In `App.tsx`'s `handleSubmit`, add an early return guard `if (abortRef.current) return;`. In `Composer.tsx`, use functional updates for `setInput((prev) => prev.slice(...) + ch + ...)` to prevent dropped inputs.