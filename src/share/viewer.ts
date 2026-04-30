export function viewerHTML(sseUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>petricode</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  ::selection { background: rgba(74,222,128,0.3); }
  body {
    font-family: 'Lora', 'Charter', 'Bitstream Charter', 'Sitka Text', Cambria, Georgia, serif;
    font-size: 19px;
    line-height: 1.4;
    background: #18181b;
    color: #d4d4d8;
    padding: 20px;
    max-width: 700px;
    margin: 0 auto;
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid #3f3f46;
    margin-bottom: 1rem;
  }
  header h1 {
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    font-size: 1rem;
    font-weight: 600;
    color: #fafafa;
  }
  #status {
    font-family: 'Berkeley Mono', 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
    font-size: 0.7rem;
    padding: 0.15rem 0.5rem;
    border-radius: 3px;
    background: #27272a;
    color: #a1a1aa;
  }
  #status.connected { background: rgba(74,222,128,0.15); color: #4ade80; }
  #status.reconnecting { background: rgba(250,204,21,0.15); color: #facc15; }
  #conversation { display: flex; flex-direction: column; gap: 0.75em; }
  .turn {
    padding: 0.5rem 0;
    animation: fadeIn 0.15s ease-in;
  }
  @keyframes fadeIn {
    from { opacity: 0.3; transform: translateY(2px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .turn.user {
    border-left: 3px solid #60a5fa;
    padding-left: 0.75rem;
  }
  .turn.user .label {
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    color: #60a5fa;
    font-weight: 600;
    font-size: 0.7rem;
    letter-spacing: 0.02em;
    margin-bottom: 0.25rem;
  }
  .turn.assistant {
    border-left: 3px solid #c084fc;
    padding-left: 0.75rem;
  }
  .turn.assistant .label {
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    color: #c084fc;
    font-weight: 600;
    font-size: 0.7rem;
    letter-spacing: 0.02em;
    margin-bottom: 0.25rem;
  }
  .turn.system {
    border-left: 3px solid #52525b;
    padding-left: 0.75rem;
    opacity: 0.7;
  }
  .turn.system .label {
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    color: #a1a1aa;
    font-weight: 600;
    font-size: 0.7rem;
    letter-spacing: 0.02em;
    margin-bottom: 0.25rem;
  }
  .turn.system .content {
    font-family: 'Berkeley Mono', 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
    font-size: 0.8rem;
    color: #a1a1aa;
  }
  .turn.queued {
    border-left: 3px solid #facc15;
    padding-left: 0.75rem;
    opacity: 0.6;
  }
  .turn.queued .label {
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    color: #facc15;
    font-weight: 600;
    font-size: 0.7rem;
    letter-spacing: 0.02em;
    margin-bottom: 0.25rem;
  }
  .content {
    white-space: pre-wrap;
    word-wrap: break-word;
    font-size: 0.95rem;
    line-height: 1.4;
    max-width: 65ch;
  }
  .content code {
    font-family: 'Berkeley Mono', 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
    background: #27272a;
    color: #166534;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    font-size: 0.8rem;
  }
  .content pre {
    font-family: 'Berkeley Mono', 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
    background: #27272a;
    padding: 0.75rem;
    border-radius: 5px;
    overflow-x: auto;
    margin: 0.5rem 0;
    font-size: 0.8rem;
    line-height: 1.5;
  }
  #streaming {
    border-left: 3px solid #c084fc;
    padding-left: 0.75rem;
    padding: 0.5rem 0 0.5rem 0.75rem;
  }
  #streaming .label {
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    color: #c084fc;
    font-weight: 600;
    font-size: 0.7rem;
    letter-spacing: 0.02em;
    margin-bottom: 0.25rem;
  }
  #streaming .content { color: #a1a1aa; }
  #streaming .cursor {
    display: inline-block;
    width: 0.5rem;
    height: 1rem;
    background: #c084fc;
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
    background: #18181b;
    border-top: 1px solid #3f3f46;
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    font-size: 0.75rem;
    color: #52525b;
    text-align: center;
  }
  footer a {
    color: #e4e4e7;
    background: #27272a;
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
    text-decoration: none;
    transition: background 0.3s;
  }
  footer a:hover { background: #3f3f46; color: #fafafa; }
  @media (max-width: 600px) {
    body { padding: 12px; font-size: 17px; }
    .content { max-width: none; }
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
<footer>read-only · <a href="https://github.com/kimjune01/petricode">petricode</a></footer>
<script>
(function() {
  var conv = document.getElementById('conversation');
  var status = document.getElementById('status');
  var streaming = document.getElementById('streaming');
  var streamText = document.getElementById('stream-text');
  var streamBuf = '';

  function addTurn(cls, label, text) {
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
    status.textContent = 'reconnecting';
    status.className = 'reconnecting';
  };

  es.addEventListener('message.user', function(e) {
    var d = JSON.parse(e.data);
    var label = d.actor === 'host' ? 'you' : d.actor;
    addTurn('user', label, d.text || '');
  });

  es.addEventListener('message.queued', function(e) {
    var d = JSON.parse(e.data);
    addTurn('queued', d.actor + ' (queued)', d.text || '');
  });

  es.addEventListener('message.assistant', function(e) {
    streamBuf = '';
    streaming.style.display = 'none';
    streamText.textContent = '';
    var d = JSON.parse(e.data);
    addTurn('assistant', 'agent', d.text || '');
  });

  es.addEventListener('message.chunk', function(e) {
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
