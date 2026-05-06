# Bug Hunt Round 56 (codex)

Three share-feature bugs verified against source, with emphasis on concrete guest-visible behavior and access control.

---

### Bug 1 — `/share` ignores room scope and always creates a posting-capable invite

**File:** `src/commands/share.ts:37`

**Description:**
The share handler receives the raw slash-command arguments but never reads them, then unconditionally creates a kitchen invite:

```ts
return (args: string): CommandResult | Promise<CommandResult> => {
  if (!serverStarted) {
    ctx.server.start();
    serverStarted = true;
  }

  const invite = ctx.invites.create(ctx.sessionId, "kitchen");
```

The protocol and sharing guide distinguish `/share` (living room, read-only) from `/share kitchen` (can post), and `InviteRegistry.canPost()` enforces that only `scope === "kitchen"` may send messages. Because every invite is created as `"kitchen"`, the read-only room is unreachable through the documented command path.

**User-visible impact:**
A host who types plain `/share` expecting a read-only viewer link actually gives the recipient a compose bar and POST permission. The recipient can inject guest messages into the host's agent session even though the host intended observation-only access. This is an access-control bug, not just a UI label mismatch, because `handlePost()` authorizes based on the stored invite scope.

**Suggested fix:**
Parse `args.trim()` and default to living room unless the host explicitly asks for kitchen:

```ts
const requested = args.trim().toLowerCase();
const scope: RoomScope = requested === "kitchen" ? "kitchen" : "living";
const invite = ctx.invites.create(ctx.sessionId, scope);
```

Reject unknown scope strings instead of silently granting kitchen access.

**Severity:** High

---

### Bug 2 — Browser viewer renders unsanitized assistant markdown as HTML

**File:** `src/share/viewer.ts:305`

**Description:**
The browser viewer renders assistant text through `marked.parse()` and assigns the result directly to `innerHTML`:

```js
function renderMd(text) {
  if (typeof marked !== 'undefined' && marked.parse) {
    try { return marked.parse(text, { breaks: true }); } catch(e) {}
  }
  var el = document.createElement('span');
  el.textContent = text;
  return el.innerHTML;
}
```

That output is inserted for completed assistant turns and streaming chunks:

```js
contentEl.innerHTML = renderMd(text);
streamText.innerHTML = renderMd(streamBuf);
```

There is no sanitizer between the model-controlled markdown and the DOM. Markdown libraries generally allow raw HTML unless explicitly sanitized, so assistant output containing tags like an image with an event handler becomes executable script in the invited viewer's browser.

**User-visible impact:**
A malicious or prompt-injected guest/host message can cause the assistant to emit HTML that executes in every browser viewer for the shared session. That script can read the token from the page URL, send messages with the viewer's kitchen token, or exfiltrate visible conversation contents. The terminal attach client is not affected because it renders through Ink rather than browser `innerHTML`.

**Suggested fix:**
Sanitize the parsed HTML before assigning it, or disable raw HTML support and render only a safe markdown subset. For example:

```js
function renderMd(text) {
  var html = '';
  if (typeof marked !== 'undefined' && marked.parse) {
    try { html = marked.parse(text, { breaks: true }); } catch(e) {}
  }
  if (!html) {
    var el = document.createElement('span');
    el.textContent = text;
    html = el.innerHTML;
  }
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}
```

If avoiding a sanitizer dependency, use DOM APIs/text nodes for unsafe constructs and only allow explicitly handled markdown tokens.

**Severity:** High

---

### Bug 3 — Browser kitchen client shows each sent message up to three times

**File:** `src/share/viewer.ts:441`

**Description:**
The browser viewer locally echoes a submitted message before POSTing it:

```js
input.value = '';
addTurn('queued', 'you (sending)', text);
fetch(postUrl, {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: text, txn_id: txnId })
})
```

The server immediately appends a `message.queued` event with the same `txn_id`, then the host bridge later emits `message.user` when it drains the queue:

```ts
const queuedEvent = this.eventLog.append({
  type: "message.queued",
  ...
  txn_id,
});

this.queue.enqueue({ text: body.text, actor: invite.actor, txn_id });
```

Unlike `AttachApp.tsx`, the browser viewer does not track local `txn_id`s, ignore its own `message.queued`, or replace the optimistic row when `message.user` arrives. It blindly appends all three views of the same message.

**User-visible impact:**
A kitchen guest using the browser viewer sends "Can you check the logs?" and sees an optimistic `you (sending)` row, then a second queued row from the server, then a third user row once the host processes it. The conversation appears to contain repeated guest prompts even though the agent only receives one. Other browser viewers also see both queued and final user rows, making the transcript noisy and easy to misread.

**Suggested fix:**
Mirror the reconciliation already implemented in `AttachApp.tsx`: keep a `Set` or `Map` of locally generated `txn_id`s, skip matching `message.queued` events, and replace the local row on matching `message.user`. For non-local viewers, either update the existing queued row by `txn_id` or remove queued rows once the corresponding `message.user` arrives.

**Severity:** Medium

---

### Bug 4 — `/share` can crash or leave the TUI running forever when server startup fails

**File:** `src/share/server.ts:52`

**Description:**
Starting the share server calls `Bun.serve()` directly on the fixed port:

```ts
this.server = Bun.serve({
  port: this.port,
  hostname: this.hostname,
  idleTimeout: 0,
  fetch(req) {
    return self.handleRequest(req);
  },
});
```

The `/share` command invokes that synchronously, and the app's command path does not wrap the call in `try/catch`:

```ts
if (!serverStarted) {
  ctx.server.start();
  serverStarted = true;
}
```

If port `7742` is already in use, or Bun refuses the bind for any other reason, the exception escapes the slash-command handler. For the async tunnel path there is a similar missing `.catch()` around `cmdResult.then(...)`, so rejected share setup promises do not reliably restore `phase: "composing"`.

**User-visible impact:**
Typing `/share` while another process already owns port `7742` can take down the TUI via the global unhandled exception path instead of showing a recoverable "port in use" message. If the failure happens after the command path has set phase to `"running"`, the composer can remain disabled because only the `.then()` success branch returns it to composing.

**Suggested fix:**
Make `makeShareHandler` catch startup failures and return a normal command result, or catch both sync and async command failures in `App.tsx`:

```ts
try {
  ctx.server.start();
  serverStarted = true;
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  return { output: `Failed to start share server: ${msg}` };
}
```

Also add `.catch()` to the promise command branch so any rejected tunnel/startup promise reports an error and resets the phase.

**Severity:** Medium

---

## Rejected / considered but false

- **SSE replay losing live events during connect** — rejected. `handleSSE()` installs a temporary event-log listener before replay, drains the buffer with an index loop, then unsubscribes and adds the live connection synchronously with no `await` between those steps.
- **The browser compose-bar probe enqueues an empty guest message** — rejected. The `{}` probe reaches `handlePost()`, but the `!body.text || typeof body.text !== "string"` check returns 400 before `eventLog.append()` or `queue.enqueue()`.
- **Terminal `petricode attach` has the same local-echo duplication as the browser** — rejected. `AttachApp.tsx` tracks local `txn_id`s, skips matching `message.queued`, and replaces the optimistic row when the corresponding `message.user` event arrives.
