import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { createBackbone } from "../index.js";

const PORT = Number.parseInt(process.env.DASHBOARD_PORT ?? process.env.PORT ?? "8787", 10) || 8787;
const HOST = process.env.DASHBOARD_HOST ?? "0.0.0.0";
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN?.trim();
const DEFAULT_USER_EXTERNAL_ID = process.env.TODO_USER_ID ?? "local-user";

const backbone = createBackbone({ filePath: process.env.DB_PATH });

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(html);
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, {
    ok: false,
    error: "Unauthorized. Provide Authorization: Bearer <DASHBOARD_TOKEN>",
  });
}

function isAuthorized(req: IncomingMessage): boolean {
  if (!DASHBOARD_TOKEN) return true;
  const auth = req.headers.authorization;
  if (!auth) return false;
  const [scheme, token] = auth.split(" ");
  return scheme?.toLowerCase() === "bearer" && token === DASHBOARD_TOKEN;
}

async function readJsonBody<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>✨ Todo &amp; Reminder Dashboard ✨</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Fredoka+One&family=Nunito:wght@400;700;900&display=swap');

    :root {
      --pink: #ff6eb4;
      --purple: #a855f7;
      --blue: #3b82f6;
      --yellow: #fde047;
      --orange: #fb923c;
      --green: #4ade80;
      --red: #f87171;
    }

    * { box-sizing: border-box; }

    body {
      font-family: 'Nunito', 'Trebuchet MS', Verdana, sans-serif;
      margin: 0;
      min-height: 100vh;
      background: linear-gradient(135deg, #1e0533 0%, #0d1b6e 40%, #0a3d62 100%);
      background-attachment: fixed;
      color: #fff;
      overflow-x: hidden;
    }

    /* Twinkling stars background */
    body::before {
      content: '⭐✨🌟💫⭐✨🌟💫⭐✨🌟💫⭐✨🌟💫⭐✨🌟💫⭐✨🌟💫⭐✨🌟💫⭐✨🌟💫';
      position: fixed;
      top: 0; left: 0; right: 0;
      font-size: 18px;
      opacity: 0.15;
      letter-spacing: 10px;
      line-height: 2.2;
      word-break: break-all;
      pointer-events: none;
      z-index: 0;
      animation: drift 20s linear infinite;
    }
    @keyframes drift { from { transform: translateY(0); } to { transform: translateY(-60px); } }

    .wrap { max-width: 1200px; margin: 0 auto; padding: 24px 20px; position: relative; z-index: 1; }

    /* ===== HEADER ===== */
    .site-header {
      text-align: center;
      margin-bottom: 28px;
      padding: 24px 20px 20px;
      background: linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.06) 100%);
      border: 2px solid rgba(255,255,255,0.3);
      border-radius: 20px;
      box-shadow: 0 8px 32px rgba(168,85,247,0.4), inset 0 1px 0 rgba(255,255,255,0.4);
      position: relative;
      overflow: hidden;
    }
    .site-header::after {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 50%;
      background: linear-gradient(180deg, rgba(255,255,255,0.15) 0%, transparent 100%);
      border-radius: 20px 20px 0 0;
      pointer-events: none;
    }

    h1 {
      font-family: 'Fredoka One', 'Comic Sans MS', cursive;
      font-size: clamp(2rem, 5vw, 3.5rem);
      margin: 0 0 6px;
      background: linear-gradient(90deg, #ff6eb4, #fde047, #4ade80, #3b82f6, #a855f7, #ff6eb4);
      background-size: 300% 100%;
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      animation: rainbow 4s linear infinite;
      text-shadow: none;
      filter: drop-shadow(0 2px 6px rgba(255,110,180,0.6));
    }
    @keyframes rainbow { 0% { background-position: 0% 50%; } 100% { background-position: 300% 50%; } }

    .tagline {
      font-size: 14px;
      color: rgba(255,255,255,0.7);
      margin: 0;
      letter-spacing: 1px;
    }
    .tagline span { color: var(--yellow); font-weight: 900; }

    /* ===== PANEL ===== */
    .panel {
      background: linear-gradient(160deg, rgba(255,255,255,0.13) 0%, rgba(255,255,255,0.05) 100%);
      border: 1.5px solid rgba(255,255,255,0.25);
      border-radius: 18px;
      padding: 18px;
      margin-bottom: 20px;
      box-shadow: 0 6px 24px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.25);
      position: relative;
      overflow: hidden;
    }
    .panel::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 40%;
      background: linear-gradient(180deg, rgba(255,255,255,0.1) 0%, transparent 100%);
      border-radius: 18px 18px 0 0;
      pointer-events: none;
    }

    h2 {
      font-family: 'Fredoka One', 'Comic Sans MS', cursive;
      font-size: 1.5rem;
      margin: 0 8px 0 0;
      text-shadow: 0 2px 8px rgba(0,0,0,0.4);
    }
    .panel-todos h2   { color: var(--yellow); }
    .panel-reminders h2 { color: var(--pink); }
    .panel-controls h2  { color: var(--green); }

    /* ===== CONTROLS ===== */
    .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }

    label {
      font-size: 12px;
      font-weight: 900;
      letter-spacing: 1px;
      text-transform: uppercase;
      color: rgba(255,255,255,0.6);
    }

    input, select {
      border-radius: 50px;
      border: 2px solid rgba(255,255,255,0.2);
      background: rgba(0,0,0,0.35);
      color: #fff;
      padding: 6px 14px;
      font-family: inherit;
      font-size: 13px;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    input:focus, select:focus {
      border-color: var(--pink);
      box-shadow: 0 0 0 3px rgba(255,110,180,0.3);
    }
    select option { background: #1e0533; }
    .token { width: 280px; }

    /* ===== BUTTONS ===== */
    button {
      cursor: pointer;
      font-family: 'Nunito', inherit;
      font-weight: 900;
      font-size: 12px;
      letter-spacing: 0.5px;
      padding: 7px 14px;
      border-radius: 50px;
      border: none;
      position: relative;
      overflow: hidden;
      transition: transform 0.12s, box-shadow 0.12s;
      text-shadow: 0 1px 2px rgba(0,0,0,0.4);
    }
    button::after {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 50%;
      background: rgba(255,255,255,0.25);
      border-radius: 50px 50px 0 0;
      pointer-events: none;
    }
    button:hover  { transform: translateY(-2px) scale(1.04); }
    button:active { transform: translateY(1px) scale(0.97); }

    button.primary {
      background: linear-gradient(180deg, #60a5fa 0%, #2563eb 100%);
      box-shadow: 0 4px 12px rgba(37,99,235,0.5), inset 0 1px 0 rgba(255,255,255,0.35);
      color: #fff;
    }
    button.warn {
      background: linear-gradient(180deg, #f87171 0%, #dc2626 100%);
      box-shadow: 0 4px 12px rgba(220,38,38,0.5), inset 0 1px 0 rgba(255,255,255,0.35);
      color: #fff;
    }
    button.neutral {
      background: linear-gradient(180deg, #94a3b8 0%, #475569 100%);
      box-shadow: 0 4px 12px rgba(71,85,105,0.5), inset 0 1px 0 rgba(255,255,255,0.3);
      color: #fff;
    }
    button#reload {
      background: linear-gradient(180deg, #86efac 0%, #16a34a 100%);
      box-shadow: 0 4px 14px rgba(22,163,74,0.5), inset 0 1px 0 rgba(255,255,255,0.4);
      color: #fff;
      font-size: 13px;
      padding: 8px 20px;
    }

    /* ===== TABLE ===== */
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th {
      text-align: left;
      padding: 10px 8px;
      font-size: 11px;
      font-weight: 900;
      letter-spacing: 1px;
      text-transform: uppercase;
      color: rgba(255,255,255,0.5);
      border-bottom: 2px solid rgba(255,255,255,0.1);
    }
    td {
      padding: 9px 8px;
      vertical-align: middle;
      border-bottom: 1px solid rgba(255,255,255,0.07);
    }
    tr:hover td { background: rgba(255,255,255,0.04); }
    td input, td select {
      border-radius: 8px;
      padding: 5px 8px;
      width: 100%;
      min-width: 80px;
    }

    /* ID badge */
    .id-badge {
      display: inline-block;
      background: linear-gradient(135deg, var(--purple), var(--pink));
      color: #fff;
      font-weight: 900;
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 50px;
      box-shadow: 0 2px 6px rgba(168,85,247,0.5);
    }

    /* Status pills */
    .pill {
      display: inline-block;
      font-size: 10px;
      font-weight: 900;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      padding: 3px 10px;
      border-radius: 50px;
    }
    .pill-open    { background: linear-gradient(90deg,#4ade80,#16a34a); color:#fff; box-shadow:0 2px 6px rgba(74,222,128,.4); }
    .pill-done    { background: linear-gradient(90deg,#94a3b8,#475569); color:#fff; }
    .pill-cancelled { background: linear-gradient(90deg,#f87171,#dc2626); color:#fff; box-shadow:0 2px 6px rgba(248,113,113,.4); }
    .pill-pending { background: linear-gradient(90deg,#fbbf24,#d97706); color:#fff; box-shadow:0 2px 6px rgba(251,191,36,.4); }
    .pill-sent    { background: linear-gradient(90deg,#60a5fa,#2563eb); color:#fff; box-shadow:0 2px 6px rgba(96,165,250,.4); }

    /* ===== STATUS BAR ===== */
    .status-bar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 16px;
      background: rgba(0,0,0,0.3);
      border-radius: 50px;
      border: 1px solid rgba(255,255,255,0.1);
      font-size: 13px;
    }
    .status-dot {
      width: 10px; height: 10px;
      border-radius: 50%;
      background: var(--green);
      box-shadow: 0 0 8px var(--green);
      animation: pulse 2s ease-in-out infinite;
      flex-shrink: 0;
    }
    .status-dot.error { background: var(--red); box-shadow: 0 0 8px var(--red); }
    @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
    #status { color: rgba(255,255,255,0.85); }

    /* ===== SECTION DECORATORS ===== */
    .section-emoji { font-size: 1.4rem; margin-right: 6px; }

    /* ===== EMPTY STATE ===== */
    .empty-state {
      text-align: center;
      padding: 32px;
      color: rgba(255,255,255,0.35);
      font-size: 13px;
    }
    .empty-state .empty-icon { font-size: 2.5rem; display:block; margin-bottom:8px; }

    /* scrollbar */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: rgba(0,0,0,0.2); border-radius: 3px; }
    ::-webkit-scrollbar-thumb { background: rgba(168,85,247,0.6); border-radius: 3px; }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="site-header">
      <h1>✨ Todo &amp; Reminder Dashboard ✨</h1>
      <p class="tagline">your personal <span>super-powered</span> productivity command centre 🚀</p>
    </header>

    <div class="panel panel-controls">
      <div class="row">
        <h2><span class="section-emoji">⚙️</span>Controls</h2>
      </div>
      <div class="row">
        <label>👤 User</label>
        <input id="userExternalId" value="${DEFAULT_USER_EXTERNAL_ID}" />
        <label>🔑 Bearer token</label>
        <input id="token" class="token" placeholder="Only needed if DASHBOARD_TOKEN is set" />
        <button id="reload">🔄 Reload Everything</button>
      </div>
      <div class="status-bar">
        <span class="status-dot" id="statusDot"></span>
        <span id="status">Ready to rock! 🤘</span>
      </div>
    </div>

    <div class="panel panel-todos">
      <div class="row">
        <h2><span class="section-emoji">✅</span>Todos</h2>
        <label>🔍 Status</label>
        <select id="todoStatusFilter">
          <option value="all">all</option>
          <option value="open" selected>open</option>
          <option value="done">done</option>
          <option value="cancelled">cancelled</option>
        </select>
      </div>
      <table>
        <thead>
          <tr><th>🎫 ID</th><th>💡 Status</th><th>📝 Title</th><th>📄 Notes</th><th>🔥 Priority</th><th>📅 Due</th><th>⚡ Actions</th></tr>
        </thead>
        <tbody id="todoRows"></tbody>
      </table>
    </div>

    <div class="panel panel-reminders">
      <div class="row">
        <h2><span class="section-emoji">⏰</span>Reminders</h2>
        <label>🔍 Status</label>
        <select id="reminderStatusFilter">
          <option value="all">all</option>
          <option value="pending" selected>pending</option>
          <option value="sent">sent</option>
          <option value="cancelled">cancelled</option>
        </select>
      </div>
      <table>
        <thead>
          <tr><th>🎫 ID</th><th>💡 Status</th><th>💬 Text</th><th>🕒 Time</th><th>🌐 Timezone</th><th>🔁 Recurrence</th><th>⚡ Actions</th></tr>
        </thead>
        <tbody id="reminderRows"></tbody>
      </table>
    </div>
  </div>

  <script>
    const statusEl = document.getElementById('status');
    const statusDotEl = document.getElementById('statusDot');
    const todoRowsEl = document.getElementById('todoRows');
    const reminderRowsEl = document.getElementById('reminderRows');
    const tokenInputEl = document.getElementById('token');

    (function bootstrapTokenFromQuery() {
      const params = new URLSearchParams(window.location.search);
      const tokenFromQuery = (params.get('token') || '').trim();
      const tokenFromStorage = (window.localStorage.getItem('dashboardBearerToken') || '').trim();

      if (tokenFromQuery) {
        tokenInputEl.value = tokenFromQuery;
        window.localStorage.setItem('dashboardBearerToken', tokenFromQuery);

        params.delete('token');
        const nextQuery = params.toString();
        const nextUrl = window.location.pathname + (nextQuery ? ('?' + nextQuery) : '') + window.location.hash;
        window.history.replaceState(null, '', nextUrl);
        return;
      }

      if (tokenFromStorage) {
        tokenInputEl.value = tokenFromStorage;
      }
    })();

    function setStatus(msg, isError = false) {
      statusEl.textContent = msg;
      statusEl.style.color = isError ? '#fca5a5' : 'rgba(255,255,255,0.85)';
      if (statusDotEl) {
        statusDotEl.className = 'status-dot' + (isError ? ' error' : '');
      }
    }

    function statusPill(status) {
      const map = {
        open: 'pill pill-open',
        done: 'pill pill-done',
        cancelled: 'pill pill-cancelled',
        pending: 'pill pill-pending',
        sent: 'pill pill-sent',
      };
      const cls = map[status] || 'pill pill-done';
      return '<span class="' + cls + '">' + status + '</span>';
    }

    function tokenHeader() {
      const token = tokenInputEl.value.trim();
      if (token) {
        window.localStorage.setItem('dashboardBearerToken', token);
      } else {
        window.localStorage.removeItem('dashboardBearerToken');
      }
      return token ? { Authorization: 'Bearer ' + token } : {};
    }

    function userId() {
      return document.getElementById('userExternalId').value.trim() || 'local-user';
    }

    function toLocalInputValue(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '';
      const offsetMs = d.getTimezoneOffset() * 60000;
      return new Date(d.getTime() - offsetMs).toISOString().slice(0, 16);
    }

    function localInputToIso(value) {
      if (!value) return undefined;
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
    }

    async function api(path, options = {}) {
      const res = await fetch(path, {
        ...options,
        headers: {
          'content-type': 'application/json',
          ...tokenHeader(),
          ...(options.headers || {}),
        },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || ('HTTP ' + res.status));
      }
      return data;
    }

    function esc(value) {
      return String(value ?? '').replace(/"/g, '&quot;');
    }

    function todoRow(todo) {
      const dueLocal = toLocalInputValue(todo.dueAt);
      const priorityOptions = ['low', 'normal', 'high', 'urgent']
        .map((p) => '<option value="' + p + '" ' + (todo.priority === p ? 'selected' : '') + '>' + p + '</option>')
        .join('');

      return '<tr data-id="' + todo.id + '">' +
        '<td><span class="id-badge">#' + todo.id + '</span></td>' +
        '<td>' + statusPill(todo.status) + '</td>' +
        '<td><input data-field="title" value="' + esc(todo.title) + '" /></td>' +
        '<td><input data-field="notes" value="' + esc(todo.notes) + '" /></td>' +
        '<td><select data-field="priority">' + priorityOptions + '</select></td>' +
        '<td><input data-field="dueAt" type="datetime-local" value="' + dueLocal + '" /></td>' +
        '<td><div class="row">' +
        '<button data-action="saveTodo" class="primary">💾 Save</button>' +
        '<button data-action="clearDue" class="neutral">🗑️ Due</button>' +
        '<button data-action="clearNotes" class="neutral">🗑️ Notes</button>' +
        '<button data-action="completeTodo" class="primary">✅ Done</button>' +
        '<button data-action="cancelTodo" class="warn">❌ Cancel</button>' +
        '</div></td>' +
        '</tr>';
    }

    function reminderRow(reminder) {
      const remindLocal = toLocalInputValue(reminder.remindAt);
      return '<tr data-id="' + reminder.id + '">' +
        '<td><span class="id-badge">#' + reminder.id + '</span></td>' +
        '<td>' + statusPill(reminder.status) + '</td>' +
        '<td><input data-field="text" value="' + esc(reminder.text) + '" /></td>' +
        '<td><input data-field="remindAt" type="datetime-local" value="' + remindLocal + '" /></td>' +
        '<td><input data-field="timezone" value="' + esc(reminder.timezone) + '" /></td>' +
        '<td><input data-field="recurrenceRule" value="' + esc(reminder.recurrenceRule) + '" /></td>' +
        '<td><div class="row">' +
        '<button data-action="saveReminder" class="primary">💾 Save</button>' +
        '<button data-action="clearRecurrence" class="neutral">🔁 Clear</button>' +
        '<button data-action="cancelReminder" class="warn">❌ Cancel</button>' +
        '</div></td>' +
        '</tr>';
    }

    async function loadTodos() {
      const status = document.getElementById('todoStatusFilter').value;
      const qs = new URLSearchParams({ userExternalId: userId(), limit: '200' });
      if (status !== 'all') qs.set('status', status);
      const data = await api('/api/todos?' + qs.toString(), { method: 'GET', headers: {} });
      todoRowsEl.innerHTML = data.todos.map(todoRow).join('') || '<tr><td colspan="7"><div class="empty-state"><span class="empty-icon">🌵</span>No todos found — go touch grass!</div></td></tr>';
    }

    async function loadReminders() {
      const status = document.getElementById('reminderStatusFilter').value;
      const qs = new URLSearchParams({ userExternalId: userId(), limit: '200' });
      if (status !== 'all') qs.set('status', status);
      const data = await api('/api/reminders?' + qs.toString(), { method: 'GET', headers: {} });
      reminderRowsEl.innerHTML = data.reminders.map(reminderRow).join('') || '<tr><td colspan="7"><div class="empty-state"><span class="empty-icon">⏰</span>No reminders — you\'re living in the moment!</div></td></tr>';
    }

    async function reloadAll() {
      setStatus('Loading...');
      try {
        await Promise.all([loadTodos(), loadReminders()]);
        setStatus('All loaded! Looking fresh 🤩');
      } catch (err) {
        setStatus(err.message || String(err), true);
      }
    }

    document.getElementById('reload').addEventListener('click', reloadAll);
    document.getElementById('todoStatusFilter').addEventListener('change', reloadAll);
    document.getElementById('reminderStatusFilter').addEventListener('change', reloadAll);

    todoRowsEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const tr = btn.closest('tr');
      const id = Number(tr.dataset.id);
      const title = tr.querySelector('[data-field="title"]').value.trim();
      const notes = tr.querySelector('[data-field="notes"]').value;
      const priority = tr.querySelector('[data-field="priority"]').value;
      const dueAt = localInputToIso(tr.querySelector('[data-field="dueAt"]').value);

      try {
        if (btn.dataset.action === 'saveTodo') {
          await api('/api/todos/' + id, { method: 'PATCH', body: JSON.stringify({ userExternalId: userId(), title, notes, priority, dueAt }) });
          setStatus('💾 Todo #' + id + ' saved! Awesome sauce 🌟');
        } else if (btn.dataset.action === 'clearDue') {
          await api('/api/todos/' + id, { method: 'PATCH', body: JSON.stringify({ userExternalId: userId(), clearDueAt: true }) });
          setStatus('🗑️ Due date cleared for #' + id + ' — living dangerously!');
        } else if (btn.dataset.action === 'clearNotes') {
          await api('/api/todos/' + id, { method: 'PATCH', body: JSON.stringify({ userExternalId: userId(), clearNotes: true }) });
          setStatus('🗑️ Notes wiped for #' + id + ' — fresh slate!');
        } else if (btn.dataset.action === 'completeTodo') {
          await api('/api/todos/' + id + '/complete', { method: 'POST', body: JSON.stringify({ userExternalId: userId() }) });
          setStatus('✅ Todo #' + id + ' crushed it! 💪');
        } else if (btn.dataset.action === 'cancelTodo') {
          await api('/api/todos/' + id + '/cancel', { method: 'POST', body: JSON.stringify({ userExternalId: userId() }) });
          setStatus('❌ Todo #' + id + ' cancelled. Maybe next time! 🤷');
        }
        await reloadAll();
      } catch (err) {
        setStatus(err.message || String(err), true);
      }
    });

    reminderRowsEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const tr = btn.closest('tr');
      const id = Number(tr.dataset.id);
      const text = tr.querySelector('[data-field="text"]').value.trim();
      const remindAt = localInputToIso(tr.querySelector('[data-field="remindAt"]').value);
      const timezone = tr.querySelector('[data-field="timezone"]').value.trim();
      const recurrenceRule = tr.querySelector('[data-field="recurrenceRule"]').value.trim();

      try {
        if (btn.dataset.action === 'saveReminder') {
          await api('/api/reminders/' + id, {
            method: 'PATCH',
            body: JSON.stringify({
              userExternalId: userId(),
              text,
              remindAt,
              timezone: timezone || undefined,
              recurrenceRule: recurrenceRule || undefined,
            }),
          });
          setStatus('💾 Reminder #' + id + ' updated! 🔔 ding ding!');
        } else if (btn.dataset.action === 'clearRecurrence') {
          await api('/api/reminders/' + id, { method: 'PATCH', body: JSON.stringify({ userExternalId: userId(), clearRecurrenceRule: true }) });
          setStatus('🔁 Recurrence cleared for #' + id + ' — one and done!');
        } else if (btn.dataset.action === 'cancelReminder') {
          await api('/api/reminders/' + id + '/cancel', { method: 'POST', body: JSON.stringify({ userExternalId: userId() }) });
          setStatus('❌ Reminder #' + id + ' cancelled. Silence is golden! 🥇');
        }
        await reloadAll();
      } catch (err) {
        setStatus(err.message || String(err), true);
      }
    });

    reloadAll();
  </script>
</body>
</html>`;
}

const server = createServer(async (req, res) => {
  try {
    if (!req.url) return sendJson(res, 400, { ok: false, error: "Missing URL" });
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/health") {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/") {
      return sendHtml(res, dashboardHtml());
    }

    if (!isAuthorized(req)) {
      return unauthorized(res);
    }

    if (req.method === "GET" && url.pathname === "/api/todos") {
      const userExternalId = url.searchParams.get("userExternalId") ?? DEFAULT_USER_EXTERNAL_ID;
      const status = url.searchParams.get("status") || undefined;
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "200", 10) || 200;
      const todos = backbone.todoService.listTodos({
        userExternalId,
        status: status === "all" ? undefined : (status as "open" | "done" | "cancelled" | undefined),
        limit,
      });
      return sendJson(res, 200, { ok: true, todos });
    }

    if (req.method === "GET" && url.pathname === "/api/reminders") {
      const userExternalId = url.searchParams.get("userExternalId") ?? DEFAULT_USER_EXTERNAL_ID;
      const status = url.searchParams.get("status") || undefined;
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "200", 10) || 200;
      const reminders = backbone.reminderService.listReminders({
        userExternalId,
        status: status === "all" ? undefined : (status as "pending" | "sent" | "cancelled" | undefined),
        limit,
      });
      return sendJson(res, 200, { ok: true, reminders });
    }

    const todoPatch = req.method === "PATCH" ? url.pathname.match(/^\/api\/todos\/(\d+)$/) : null;
    if (todoPatch) {
      const todoId = Number(todoPatch[1]);
      const body = await readJsonBody(req);
      const userExternalId = normalizeOptionalString((body as { userExternalId?: unknown }).userExternalId) ??
        DEFAULT_USER_EXTERNAL_ID;

      const updated = backbone.todoService.updateTodo({
        userExternalId,
        todoId,
        title: normalizeOptionalString((body as { title?: unknown }).title),
        notes: typeof (body as { notes?: unknown }).notes === "string" ? (body as { notes: string }).notes : undefined,
        clearNotes: (body as { clearNotes?: unknown }).clearNotes === true,
        priority: normalizeOptionalString((body as { priority?: unknown }).priority) as
          | "low"
          | "normal"
          | "high"
          | "urgent"
          | undefined,
        dueAt: normalizeOptionalString((body as { dueAt?: unknown }).dueAt),
        clearDueAt: (body as { clearDueAt?: unknown }).clearDueAt === true,
      });
      return sendJson(res, 200, { ok: true, todo: updated });
    }

    const todoComplete = req.method === "POST" ? url.pathname.match(/^\/api\/todos\/(\d+)\/complete$/) : null;
    if (todoComplete) {
      const todoId = Number(todoComplete[1]);
      const body = await readJsonBody(req);
      const userExternalId = normalizeOptionalString((body as { userExternalId?: unknown }).userExternalId) ??
        DEFAULT_USER_EXTERNAL_ID;
      const updated = backbone.todoService.completeTodo({ userExternalId, todoId });
      return sendJson(res, 200, { ok: true, todo: updated });
    }

    const todoCancel = req.method === "POST" ? url.pathname.match(/^\/api\/todos\/(\d+)\/cancel$/) : null;
    if (todoCancel) {
      const todoId = Number(todoCancel[1]);
      const body = await readJsonBody(req);
      const userExternalId = normalizeOptionalString((body as { userExternalId?: unknown }).userExternalId) ??
        DEFAULT_USER_EXTERNAL_ID;
      const updated = backbone.todoService.cancelTodo({ userExternalId, todoId });
      return sendJson(res, 200, { ok: true, todo: updated });
    }

    const reminderPatch = req.method === "PATCH" ? url.pathname.match(/^\/api\/reminders\/(\d+)$/) : null;
    if (reminderPatch) {
      const reminderId = Number(reminderPatch[1]);
      const body = await readJsonBody(req);
      const userExternalId = normalizeOptionalString((body as { userExternalId?: unknown }).userExternalId) ??
        DEFAULT_USER_EXTERNAL_ID;

      const updated = backbone.reminderService.updateReminder({
        userExternalId,
        reminderId,
        text: normalizeOptionalString((body as { text?: unknown }).text),
        remindAt: normalizeOptionalString((body as { remindAt?: unknown }).remindAt),
        timezone: normalizeOptionalString((body as { timezone?: unknown }).timezone),
        recurrenceRule: normalizeOptionalString((body as { recurrenceRule?: unknown }).recurrenceRule),
        clearRecurrenceRule: (body as { clearRecurrenceRule?: unknown }).clearRecurrenceRule === true,
      });
      return sendJson(res, 200, { ok: true, reminder: updated });
    }

    const reminderCancel = req.method === "POST" ? url.pathname.match(/^\/api\/reminders\/(\d+)\/cancel$/) : null;
    if (reminderCancel) {
      const reminderId = Number(reminderCancel[1]);
      const body = await readJsonBody(req);
      const userExternalId = normalizeOptionalString((body as { userExternalId?: unknown }).userExternalId) ??
        DEFAULT_USER_EXTERNAL_ID;
      const updated = backbone.reminderService.cancelReminder({ userExternalId, reminderId });
      return sendJson(res, 200, { ok: true, reminder: updated });
    }

    return sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Dashboard listening on http://${HOST}:${PORT}`);
  if (DASHBOARD_TOKEN) {
    console.log("Dashboard auth enabled (Bearer token required).");
  } else {
    console.log("Dashboard auth disabled (set DASHBOARD_TOKEN to secure it).");
  }
});

process.on("SIGINT", () => {
  backbone.close();
  server.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  backbone.close();
  server.close(() => process.exit(0));
});
