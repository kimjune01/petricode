export function viewerHTML(sseUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/marked@15/lib/marked.umd.min.js"></script>
<title>petricode</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  ::selection { background: rgba(74,222,128,0.3); }

  body {
    font-family: 'JetBrains Mono', ui-monospace, 'Fira Code', monospace;
    font-size: 15px;
    line-height: 1.4;
    background: #18181b;
    color: #d4d4d8;
    padding: 20px;
    padding-bottom: 48px;
    max-width: 700px;
    margin: 0 auto;
  }

  /* — Header — */
  header {
    position: sticky;
    top: 0;
    background: #18181b;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 0;
    border-bottom: 1px solid #3f3f46;
    margin-bottom: 16px;
    z-index: 1;
  }
  header h1 {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 1rem;
    font-weight: 600;
    color: #fafafa;
  }
  #status {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 0.7rem;
    padding: 2px 8px;
    border-radius: 3px;
    background: #27272a;
    color: #a1a1aa;
  }
  #status.connected { background: rgba(74,222,128,0.15); color: #4ade80; }
  #status.reconnecting { background: rgba(250,204,21,0.15); color: #facc15; }
  #status.error { background: rgba(239,68,68,0.15); color: #f87171; }

  /* — Conversation — */
  main { display: flex; flex-direction: column; gap: 12px; }

  .turn { padding: 8px 0; }
  @media (prefers-reduced-motion: no-preference) {
    .turn { animation: fadeIn 0.15s ease-in; }
  }
  @keyframes fadeIn {
    from { opacity: 0.3; transform: translateY(2px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .label {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-weight: 600;
    font-size: 0.7rem;
    letter-spacing: 0.02em;
    margin-bottom: 4px;
    text-transform: uppercase;
  }
  .content {
    white-space: pre-wrap;
    word-wrap: break-word;
    font-size: 0.9rem;
    line-height: 1.4;
    max-width: 65ch;
  }

  /* User turns */
  .turn.user { border-left: 3px solid #60a5fa; padding-left: 12px; }
  .turn.user .label { color: #60a5fa; }

  /* Assistant turns */
  .turn.assistant { border-left: 3px solid #c084fc; padding-left: 12px; }
  .turn.assistant .label { color: #c084fc; }

  /* System/tool turns */
  .turn.system { border-left: 3px solid #52525b; padding-left: 12px; }
  .turn.system .label { color: #a1a1aa; }
  .turn.system .content {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 0.8rem;
    color: #a1a1aa;
  }

  /* Queued turns */
  .turn.queued { border-left: 3px solid #facc15; padding-left: 12px; opacity: 0.7; }
  .turn.queued .label { color: #facc15; }
  .turn.queued::after {
    content: 'queued';
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 0.65rem;
    color: #facc15;
    background: rgba(250,204,21,0.1);
    padding: 1px 6px;
    border-radius: 3px;
    margin-left: 8px;
    vertical-align: middle;
  }

  /* Code */
  .content code {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    background: #27272a;
    color: #d4d4d8;
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 0.8rem;
  }
  .content pre {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    background: #27272a;
    padding: 12px;
    border-radius: 5px;
    overflow-x: auto;
    margin: 8px 0;
    font-size: 0.8rem;
    line-height: 1.5;
  }

  .content a { color: #60a5fa; text-decoration: underline; text-underline-offset: 2px; }
  .content a:hover { color: #93bbfd; }
  .content ul, .content ol { padding-left: 1.5em; margin: 4px 0; }
  .content li { margin: 2px 0; }
  .content h1, .content h2, .content h3 { color: #fafafa; margin: 8px 0 4px; font-size: 1em; }
  .content blockquote { border-left: 3px solid #3f3f46; padding-left: 8px; color: #a1a1aa; margin: 4px 0; }
  .content p { margin: 4px 0; }
  .content img { max-width: 100%; border-radius: 4px; }

  /* Streaming */
  #streaming {
    border-left: 3px solid #c084fc;
    padding: 8px 0 8px 12px;
  }
  #streaming .label { color: #c084fc; }
  #streaming .content { color: #d4d4d8; }
  #streaming .cursor {
    display: inline-block;
    width: 8px;
    height: 1rem;
    background: #c084fc;
    vertical-align: text-bottom;
  }
  @media (prefers-reduced-motion: no-preference) {
    #streaming .cursor { animation: blink 1s step-end infinite; }
  }
  @keyframes blink { 50% { opacity: 0; } }

  /* Empty state */
  #empty {
    text-align: center;
    padding: 48px 20px;
    color: #52525b;
    font-size: 0.9rem;
  }
  #empty span { display: block; font-size: 2rem; margin-bottom: 12px; }

  /* Footer */
  footer {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 8px 16px;
    background: #18181b;
    border-top: 1px solid #3f3f46;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 0.75rem;
    color: #52525b;
    text-align: center;
  }
  footer a {
    color: #e4e4e7;
    background: #27272a;
    padding: 1px 6px;
    border-radius: 3px;
    text-decoration: underline;
    text-decoration-color: #52525b;
    text-underline-offset: 2px;
    transition: background 0.3s;
  }
  footer a:hover { background: #3f3f46; color: #fafafa; }

  /* Compose bar */
  #compose {
    position: fixed;
    bottom: 32px;
    left: 0;
    right: 0;
    padding: 8px 16px;
    background: #18181b;
    border-top: 1px solid #3f3f46;
    display: none;
  }
  #compose form {
    max-width: 700px;
    margin: 0 auto;
    display: flex;
    gap: 8px;
  }
  #compose input {
    flex: 1;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 0.85rem;
    background: #27272a;
    color: #d4d4d8;
    border: 1px solid #3f3f46;
    border-radius: 4px;
    padding: 6px 10px;
    outline: none;
  }
  #compose input:focus { border-color: #60a5fa; }
  #compose input::placeholder { color: #52525b; }
  #compose button {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 0.8rem;
    background: #27272a;
    color: #d4d4d8;
    border: 1px solid #3f3f46;
    border-radius: 4px;
    padding: 6px 14px;
    cursor: pointer;
  }
  #compose button:hover { background: #3f3f46; color: #fafafa; }

  @media (max-width: 600px) {
    body { padding: 12px; padding-bottom: 80px; font-size: 17px; }
    .content { max-width: none; }
  }
</style>
</head>
<body>
<header>
  <span aria-hidden="true">🧫</span>
  <h1>petricode</h1>
  <span id="status" role="status" aria-live="polite">connecting</span>
</header>
<main id="conversation" role="log" aria-label="Conversation">
  <div id="empty"><span aria-hidden="true">🧫</span>Waiting for conversation&hellip;</div>
</main>
<div id="streaming" style="display:none" aria-live="polite">
  <div class="label">agent</div>
  <div class="content"><span id="stream-text"></span><span class="cursor" aria-hidden="true"></span></div>
</div>
<div id="compose">
  <form id="compose-form">
    <input id="compose-input" type="text" placeholder="Type a message..." autocomplete="off">
    <button type="submit">Send</button>
  </form>
</div>
<footer id="footer">read-only &middot; <a href="https://github.com/kimjune01/petricode">petricode</a></footer>
<script>
(function() {
  var conv = document.getElementById('conversation');
  var empty = document.getElementById('empty');
  var status = document.getElementById('status');
  var streaming = document.getElementById('streaming');
  var streamText = document.getElementById('stream-text');
  var streamBuf = '';
  var hasContent = false;
  var lastFrameAt = 0;
  var watchdog = null;

  function resetWatchdog() {
    lastFrameAt = Date.now();
    if (watchdog) clearInterval(watchdog);
    watchdog = setInterval(function() {
      var elapsed = Date.now() - lastFrameAt;
      if (elapsed > 20000) {
        status.textContent = 'disconnected';
        status.className = 'error';
      } else if (elapsed > 5000 && status.className === 'connected') {
        status.textContent = 'idle';
        status.className = 'connected';
      }
    }, 3000);
  }

  function hideEmpty() {
    if (!hasContent && empty) {
      empty.style.display = 'none';
      hasContent = true;
    }
  }

  function renderMd(text) {
    if (typeof marked !== 'undefined' && marked.parse) {
      try { return marked.parse(text, { breaks: true }); } catch(e) {}
    }
    var el = document.createElement('span');
    el.textContent = text;
    return el.innerHTML;
  }

  function addTurn(cls, label, text) {
    hideEmpty();
    var div = document.createElement('div');
    div.className = 'turn ' + cls;
    var labelEl = document.createElement('div');
    labelEl.className = 'label';
    labelEl.textContent = label;
    var contentEl = document.createElement('div');
    contentEl.className = 'content';
    if (cls === 'assistant') {
      contentEl.innerHTML = renderMd(text);
    } else {
      contentEl.textContent = text;
    }
    div.appendChild(labelEl);
    div.appendChild(contentEl);
    conv.appendChild(div);
    window.scrollTo(0, document.body.scrollHeight);
  }

  var url = ${JSON.stringify(sseUrl)};
  var es = new EventSource(url);

  es.onopen = function() {
    status.textContent = 'connected';
    status.className = 'connected';
    resetWatchdog();
  };
  es.onerror = function() {
    if (es.readyState === EventSource.CLOSED) {
      status.textContent = 'disconnected';
      status.className = 'error';
    } else {
      status.textContent = 'reconnecting';
      status.className = 'reconnecting';
    }
  };

  function onSSE(type, handler) {
    es.addEventListener(type, function(e) {
      resetWatchdog();
      handler(e);
    });
  }

  onSSE('message.user', function(e) {
    var d = JSON.parse(e.data);
    var label = d.actor === 'host' ? 'you' : d.actor;
    addTurn('user', label, d.text || '');
  });

  onSSE('message.queued', function(e) {
    var d = JSON.parse(e.data);
    addTurn('queued', d.actor, d.text || '');
  });

  onSSE('message.assistant', function(e) {
    streamBuf = '';
    streaming.style.display = 'none';
    streamText.textContent = '';
    var d = JSON.parse(e.data);
    addTurn('assistant', 'agent', d.text || '');
  });

  onSSE('message.chunk', function(e) {
    hideEmpty();
    var d = JSON.parse(e.data);
    streamBuf += d.text || '';
    streamText.textContent = streamBuf;
    streaming.style.display = 'block';
    window.scrollTo(0, document.body.scrollHeight);
  });

  onSSE('tool.request', function(e) {
    var d = JSON.parse(e.data);
    addTurn('system', 'tool', d.name + '(' + JSON.stringify(d.args || {}).slice(0, 100) + ')');
  });

  onSSE('tool.result', function(e) {
    var d = JSON.parse(e.data);
    var text = (d.result || '').slice(0, 500);
    addTurn('system', d.name, text);
  });

  onSSE('turn.complete', function(e) {
    streamBuf = '';
    streaming.style.display = 'none';
    streamText.textContent = '';
  });

  // Scope detection + compose bar
  var parsed = new URL(url);
  var sessionMatch = parsed.pathname.match(/\\/sessions\\/([^/]+)\\/events$/);
  var sessionId = sessionMatch ? sessionMatch[1] : null;
  var token = parsed.searchParams.get('token');
  var composeEl = document.getElementById('compose');
  var footerEl = document.getElementById('footer');

  if (sessionId && token) {
    var postUrl = parsed.origin + '/sessions/' + sessionId + '/messages';
    // Probe: POST with empty body — 400 = kitchen, 403 = living
    fetch(postUrl, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    }).then(function(resp) {
      if (resp.status === 400) {
        // Kitchen scope — show compose bar
        composeEl.style.display = 'block';
        footerEl.textContent = '';
        document.body.style.paddingBottom = '80px';

        var form = document.getElementById('compose-form');
        var input = document.getElementById('compose-input');
        form.addEventListener('submit', function(e) {
          e.preventDefault();
          var text = input.value.trim();
          if (!text) return;
          var txnId = 'web-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
          input.value = '';
          addTurn('queued', 'you (sending)', text);
          fetch(postUrl, {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: text, txn_id: txnId })
          }).then(function(resp) {
            if (!resp.ok) addTurn('system', 'error', 'Send failed: ' + resp.status);
          }).catch(function(err) {
            addTurn('system', 'error', 'Failed to send: ' + err.message);
          });
        });
      }
    }).catch(function() {});
  }
})();
</script>
</body>
</html>`;
}
