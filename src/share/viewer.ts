export function viewerHTML(sseUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
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

  @media (max-width: 600px) {
    body { padding: 12px; padding-bottom: 48px; font-size: 17px; }
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
<footer>read-only &middot; <a href="https://github.com/kimjune01/petricode">petricode</a></footer>
<script>
(function() {
  var conv = document.getElementById('conversation');
  var empty = document.getElementById('empty');
  var status = document.getElementById('status');
  var streaming = document.getElementById('streaming');
  var streamText = document.getElementById('stream-text');
  var streamBuf = '';
  var hasContent = false;

  function hideEmpty() {
    if (!hasContent && empty) {
      empty.style.display = 'none';
      hasContent = true;
    }
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
    contentEl.textContent = text;
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

  es.addEventListener('message.user', function(e) {
    var d = JSON.parse(e.data);
    var label = d.actor === 'host' ? 'you' : d.actor;
    addTurn('user', label, d.text || '');
  });

  es.addEventListener('message.queued', function(e) {
    var d = JSON.parse(e.data);
    addTurn('queued', d.actor, d.text || '');
  });

  es.addEventListener('message.assistant', function(e) {
    streamBuf = '';
    streaming.style.display = 'none';
    streamText.textContent = '';
    var d = JSON.parse(e.data);
    addTurn('assistant', 'agent', d.text || '');
  });

  es.addEventListener('message.chunk', function(e) {
    hideEmpty();
    var d = JSON.parse(e.data);
    streamBuf += d.text || '';
    streamText.textContent = streamBuf;
    streaming.style.display = 'block';
    window.scrollTo(0, document.body.scrollHeight);
  });

  es.addEventListener('tool.request', function(e) {
    var d = JSON.parse(e.data);
    addTurn('system', 'tool', d.name + '(' + JSON.stringify(d.args || {}).slice(0, 100) + ')');
  });

  es.addEventListener('tool.result', function(e) {
    var d = JSON.parse(e.data);
    var text = (d.result || '').slice(0, 500);
    addTurn('system', d.name, text);
  });

  es.addEventListener('turn.complete', function(e) {
    streamBuf = '';
    streaming.style.display = 'none';
    streamText.textContent = '';
  });
})();
</script>
</body>
</html>`;
}
