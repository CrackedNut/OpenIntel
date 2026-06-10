/**
 * Agent Dashboard UI — a single self-contained HTML page (no build step,
 * no external assets) served by src/panel/server.ts at `/`.
 */

export const PANEL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>claude-threads · agent dashboard</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --border: #30363d; --text: #e6edf3;
    --dim: #8b949e; --accent: #58a6ff; --green: #3fb950; --red: #f85149;
    --amber: #d29922; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: inherit; font-size: 14px; }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid var(--border); }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header .ver { color: var(--dim); font-size: 12px; }
  header .spacer { flex: 1; }
  nav { display: flex; gap: 4px; padding: 10px 20px 0; border-bottom: 1px solid var(--border); }
  nav button { background: none; border: 1px solid transparent; border-bottom: none; color: var(--dim);
    padding: 8px 14px; cursor: pointer; font: inherit; border-radius: 6px 6px 0 0; }
  nav button.active { color: var(--text); background: var(--panel); border-color: var(--border); }
  main { padding: 20px; max-width: 1100px; margin: 0 auto; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .card h2 { margin: 0 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); }
  textarea { width: 100%; min-height: 420px; background: var(--bg); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 12px; font: inherit; font-size: 13px; line-height: 1.5; resize: vertical; }
  textarea.small { min-height: 200px; }
  .row { display: flex; gap: 10px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
  button.action { background: var(--accent); color: #0d1117; border: none; border-radius: 6px;
    padding: 8px 16px; font: inherit; font-weight: 600; cursor: pointer; }
  button.danger { background: var(--red); }
  button.ghost { background: none; border: 1px solid var(--border); color: var(--text); }
  .msg { font-size: 12px; color: var(--dim); }
  .msg.ok { color: var(--green); } .msg.err { color: var(--red); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td, th { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); }
  th { color: var(--dim); font-weight: 500; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; }
  .pill.on { background: rgba(63,185,80,.15); color: var(--green); }
  .pill.off { background: rgba(248,81,73,.15); color: var(--red); }
  .pill.busy { background: rgba(210,153,34,.15); color: var(--amber); }
  select, input[type=text] { background: var(--bg); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 7px 10px; font: inherit; }
  .hint { font-size: 12px; color: var(--dim); margin: 4px 0 10px; }
  code { color: var(--accent); }
</style>
</head>
<body>
<header>
  <h1>🤖 claude-threads</h1>
  <span class="ver" id="ver"></span>
  <span class="spacer"></span>
  <span class="msg" id="globalmsg"></span>
  <button class="action danger" onclick="restartBot()">⟳ Restart bot</button>
</header>
<nav id="tabs">
  <button data-tab="status" class="active">Status</button>
  <button data-tab="config">Config</button>
  <button data-tab="soul">Soul</button>
  <button data-tab="directives">Directives</button>
  <button data-tab="projects">Projects</button>
  <button data-tab="skills">Skills</button>
</nav>
<main>
  <section id="tab-status">
    <div class="card"><h2>Platforms</h2><table id="platforms"></table></div>
    <div class="card"><h2>Active sessions</h2><table id="sessions"></table></div>
  </section>

  <section id="tab-config" hidden>
    <div class="card">
      <h2>config.yaml</h2>
      <div class="hint" id="configpath"></div>
      <textarea id="config" spellcheck="false"></textarea>
      <div class="row">
        <button class="action" onclick="saveText('/api/config', 'config', 'configmsg')">Save</button>
        <span class="msg" id="configmsg">Saving validates YAML; restart the bot to apply.</span>
      </div>
    </div>
  </section>

  <section id="tab-soul" hidden>
    <div class="card">
      <h2>SOUL.md — persona / identity / tone</h2>
      <div class="hint" id="soulpath"></div>
      <textarea id="soul" spellcheck="false"></textarea>
      <div class="row">
        <button class="action" onclick="saveText('/api/persona/soul', 'soul', 'soulmsg')">Save</button>
        <span class="msg" id="soulmsg">Picked up by the next session that starts.</span>
      </div>
    </div>
  </section>

  <section id="tab-directives" hidden>
    <div class="card">
      <h2>DIRECTIVES.md — behavioral guardrails</h2>
      <div class="hint" id="directivespath"></div>
      <textarea id="directives" spellcheck="false"></textarea>
      <div class="row">
        <button class="action" onclick="saveText('/api/persona/directives', 'directives', 'directivesmsg')">Save</button>
        <span class="msg" id="directivesmsg">Picked up by the next session that starts.</span>
      </div>
    </div>
  </section>

  <section id="tab-projects" hidden>
    <div class="card">
      <h2>Projects index</h2>
      <div class="hint">Each project's <code>description.md</code> is injected into the agent's system prompt index. Dir: <span id="projectsdir"></span></div>
      <div class="row">
        <select id="projectsel" onchange="pickEntry('projects')"></select>
        <input type="text" id="projectnew" placeholder="new-project-name">
        <button class="ghost" onclick="newEntry('projects')">+ New</button>
        <button class="ghost" onclick="delEntry('projects')">🗑 Delete</button>
      </div>
      <textarea id="projectbody" class="small" spellcheck="false" style="margin-top:10px"></textarea>
      <div class="row">
        <button class="action" onclick="saveEntry('projects')">Save</button>
        <span class="msg" id="projectsmsg"></span>
      </div>
    </div>
  </section>

  <section id="tab-skills" hidden>
    <div class="card">
      <h2>Skills</h2>
      <div class="hint">Each skill's <code>SKILL.md</code> is listed in the agent's skills index. Dir: <span id="skillsdir"></span></div>
      <div class="row">
        <select id="skillsel" onchange="pickEntry('skills')"></select>
        <input type="text" id="skillnew" placeholder="new-skill-name">
        <button class="ghost" onclick="newEntry('skills')">+ New</button>
        <button class="ghost" onclick="delEntry('skills')">🗑 Delete</button>
      </div>
      <textarea id="skillbody" class="small" spellcheck="false" style="margin-top:10px"></textarea>
      <div class="row">
        <button class="action" onclick="saveEntry('skills')">Save</button>
        <span class="msg" id="skillsmsg"></span>
      </div>
    </div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const state = { projects: [], skills: [] };
const cfg = {
  projects: { sel: 'projectsel', body: 'projectbody', input: 'projectnew', msg: 'projectsmsg' },
  skills:   { sel: 'skillsel',   body: 'skillbody',   input: 'skillnew',   msg: 'skillsmsg' },
};

document.querySelectorAll('#tabs button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  document.querySelectorAll('main section').forEach((s) => s.hidden = true);
  $('tab-' + b.dataset.tab).hidden = false;
});

function flash(id, text, ok) {
  const el = $(id); el.textContent = text; el.className = 'msg ' + (ok ? 'ok' : 'err');
  setTimeout(() => { el.className = 'msg'; }, 4000);
}

async function loadStatus() {
  try {
    const s = await (await fetch('/api/status')).json();
    $('ver').textContent = 'v' + s.version + ' · pid ' + s.pid + ' · up ' + Math.floor(s.uptimeSeconds / 60) + 'm';
    $('configpath').textContent = s.configPath;
    $('soulpath').textContent = s.paths.soul;
    $('directivespath').textContent = s.paths.directives;
    $('projectsdir').textContent = s.paths.projectsDir;
    $('skillsdir').textContent = s.paths.skillsDir;
    $('platforms').innerHTML = '<tr><th>id</th><th>type</th><th>name</th><th>state</th></tr>' +
      s.platforms.map((p) => '<tr><td>' + p.id + '</td><td>' + p.type + '</td><td>' + p.displayName +
        '</td><td><span class="pill ' + (p.connected ? 'on">connected' : 'off">disconnected') + '</span></td></tr>').join('');
    $('sessions').innerHTML = s.sessions.length
      ? '<tr><th>session</th><th>mode</th><th>title</th><th>by</th><th>state</th></tr>' +
        s.sessions.map((x) => '<tr><td>' + x.sessionId + '</td><td>' + x.mode + '</td><td>' + (x.title || '—') +
          '</td><td>@' + x.startedBy + '</td><td><span class="pill ' + (x.isProcessing ? 'busy">working' : 'on">idle') + '</span></td></tr>').join('')
      : '<tr><td class="msg">no active sessions</td></tr>';
  } catch { $('globalmsg').textContent = 'bot unreachable — restarting?'; }
}

async function loadText(url, id) { $(id).value = url === '/api/config' ? await (await fetch(url)).text() : (await (await fetch(url)).json()).content; }
async function saveText(url, id, msgId) {
  const r = await fetch(url, { method: 'PUT', body: $(id).value });
  const j = await r.json().catch(() => ({}));
  flash(msgId, r.ok ? (j.note || 'saved ✓') : ('error: ' + (j.error || r.status)), r.ok);
}

async function loadEntries(kind) {
  const j = await (await fetch('/api/' + kind)).json();
  state[kind] = j.entries;
  const sel = $(cfg[kind].sel);
  sel.innerHTML = j.entries.map((e) => '<option>' + e.name + '</option>').join('');
  pickEntry(kind);
}
function pickEntry(kind) {
  const e = state[kind].find((x) => x.name === $(cfg[kind].sel).value);
  $(cfg[kind].body).value = e ? e.content : '';
}
function newEntry(kind) {
  const name = $(cfg[kind].input).value.trim();
  if (!name) return flash(cfg[kind].msg, 'enter a name first', false);
  state[kind].push({ name, content: '' });
  $(cfg[kind].sel).innerHTML += '<option>' + name + '</option>';
  $(cfg[kind].sel).value = name; $(cfg[kind].body).value = ''; $(cfg[kind].input).value = '';
}
async function saveEntry(kind) {
  const name = $(cfg[kind].sel).value;
  if (!name) return;
  const r = await fetch('/api/' + kind + '/' + encodeURIComponent(name), { method: 'PUT', body: $(cfg[kind].body).value });
  flash(cfg[kind].msg, r.ok ? 'saved ✓' : 'error', r.ok);
  if (r.ok) loadEntries(kind);
}
async function delEntry(kind) {
  const name = $(cfg[kind].sel).value;
  if (!name || !confirm('Delete "' + name + '"?')) return;
  const r = await fetch('/api/' + kind + '/' + encodeURIComponent(name), { method: 'DELETE' });
  flash(cfg[kind].msg, r.ok ? 'deleted' : 'error', r.ok);
  if (r.ok) loadEntries(kind);
}
async function restartBot() {
  if (!confirm('Restart the bot? Active sessions persist and resume.')) return;
  await fetch('/api/restart', { method: 'POST' }).catch(() => {});
  $('globalmsg').textContent = 'restarting…';
  setTimeout(() => location.reload(), 12000);
}

loadStatus(); setInterval(loadStatus, 5000);
loadText('/api/config', 'config');
loadText('/api/persona/soul', 'soul');
loadText('/api/persona/directives', 'directives');
loadEntries('projects'); loadEntries('skills');
</script>
</body>
</html>`;
