export function viewerHTML(sseUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>petricode</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
    background: #1a1a2e;
    color: #e0e0e0;
    padding: 1rem;
    max-width: 800px;
    margin: 0 auto;
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid #333;
    margin-bottom: 1rem;
  }
  header h1 { font-size: 1rem; font-weight: 600; }
  #status {
    font-size: 0.75rem;
    padding: 0.15rem 0.5rem;
    border-radius: 3px;
    background: #333;
    color: #888;
  }
  #status.connected { background: #1a3a1a; color: #4ade80; }
  #status.reconnecting { background: #3a3a1a; color: #facc15; }
  #conversation { display: flex; flex-direction: column; gap: 0.5rem; }
  .turn { padding: 0.5rem 0; }
  .turn.user { border-left: 3px solid #60a5fa; padding-left: 0.75rem; }
  .turn.user .label { color: #60a5fa; font-weight: 600; font-size: 0.75rem; margin-bottom: 0.25rem; }
  .turn.assistant { border-left: 3px solid #a78bfa; padding-left: 0.75rem; }
  .turn.assistant .label { color: #a78bfa; font-weight: 600; font-size: 0.75rem; margin-bottom: 0.25rem; }
  .turn.system { border-left: 3px solid #666; padding-left: 0.75rem; opacity: 0.7; }
  .turn.system .label { color: #888; font-weight: 600; font-size: 0.75rem; margin-bottom: 0.25rem; }
  .turn.queued { border-left: 3px solid #facc15; padding-left: 0.75rem; opacity: 0.6; }
  .turn.queued .label { color: #facc15; font-weight: 600; font-size: 0.75rem; margin-bottom: 0.25rem; }
  .content {
    white-space: pre-wrap;
    word-wrap: break-word;
    font-size: 0.875rem;
    line-height: 1.5;
  }
  .content code {
    background: #2a2a3e;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    font-size: 0.8rem;
  }
  .content pre {
    background: #2a2a3e;
    padding: 0.75rem;
    border-radius: 4px;
    overflow-x: auto;
    margin: 0.5rem 0;
  }
  #streaming {
    border-left: 3px solid #a78bfa;
    padding-left: 0.75rem;
    padding: 0.5rem 0 0.5rem 0.75rem;
    opacity: 0.8;
  }
  #streaming .label { color: #a78bfa; font-weight: 600; font-size: 0.75rem; margin-bottom: 0.25rem; }
  #streaming .content { color: #c0c0c0; }
  #streaming .cursor {
    display: inline-block;
    width: 0.5rem;
    height: 1rem;
    background: #a78bfa;
    animation: blink 1s step-end infinite;
    vertical-align: text-bottom;
  }
  @keyframes blink { 50% { opacity: 0; } }
  footer {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 0.5rem 1rem;
    background: #1a1a2e;
    border-top: 1px solid #333;
    font-size: 0.75rem;
    color: #666;
    text-align: center;
  }
</style>
</head>
<body>
<header>
  <span>🧫</span>
  <h1>petricode</h1>
  <span id="status">connecting</span>
</header>
<div id="conversation"></div>
<div id="streaming" style="display:none">
  <div class="label">agent</div>
  <div class="content"><span id="stream-text"></span><span class="cursor"></span></div>
</div>
<footer>read-only viewer · install petricode to submit messages</footer>
<script>
(function() {
  const conv = document.getElementById('conversation');
  const status = document.getElementById('status');
  const streaming = document.getElementById('streaming');
  const streamText = document.getElementById('stream-text');
  let streamBuf = '';

  function escapeHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function addTurn(cls, label, text) {
    const div = document.createElement('div');
    div.className = 'turn ' + cls;
    div.innerHTML = '<div class="label">' + escapeHtml(label) + '</div>'
      + '<div class="content">' + escapeHtml(text) + '</div>';
    conv.appendChild(div);
    window.scrollTo(0, document.body.scrollHeight);
  }

  const url = ${JSON.stringify(sseUrl)};
  const es = new EventSource(url);

  es.onopen = function() {
    status.textContent = 'connected';
    status.className = 'connected';
  };
  es.onerror = function() {
    status.textContent = 'reconnecting';
    status.className = 'reconnecting';
  };

  es.addEventListener('message.user', function(e) {
    const d = JSON.parse(e.data);
    const label = d.actor === 'host' ? 'you' : d.actor;
    addTurn('user', label, d.text || '');
  });

  es.addEventListener('message.queued', function(e) {
    const d = JSON.parse(e.data);
    addTurn('queued', d.actor + ' (queued)', d.text || '');
  });

  es.addEventListener('message.assistant', function(e) {
    streamBuf = '';
    streaming.style.display = 'none';
    streamText.textContent = '';
    const d = JSON.parse(e.data);
    addTurn('assistant', 'agent', d.text || '');
  });

  es.addEventListener('message.chunk', function(e) {
    const d = JSON.parse(e.data);
    streamBuf += d.text || '';
    streamText.textContent = streamBuf;
    streaming.style.display = 'block';
    window.scrollTo(0, document.body.scrollHeight);
  });

  es.addEventListener('tool.request', function(e) {
    const d = JSON.parse(e.data);
    addTurn('system', 'tool', d.name + '(' + JSON.stringify(d.args || {}).slice(0, 100) + ')');
  });

  es.addEventListener('tool.result', function(e) {
    const d = JSON.parse(e.data);
    const text = (d.result || '').slice(0, 500);
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
