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
  <title>Todo &amp; Reminder Dashboard</title>
  <style>
    * { box-sizing: border-box; }

    body {
      font-family: 'Comic Sans MS', 'Comic Sans', cursive;
      margin: 0;
      min-height: 100vh;
      background-color: #1e2e42;
      background-image: radial-gradient(rgba(255,255,255,0.04) 1px, transparent 1px);
      background-size: 22px 22px;
      color: #cdd8e8;
    }

    .wrap { max-width: 1200px; margin: 0 auto; padding: 24px 20px; }

    /* ===== HEADER ===== */
    .site-header {
      text-align: center;
      margin-bottom: 22px;
      padding: 20px 20px 16px;
      background: linear-gradient(180deg, #253d58 0%, #1a2f47 100%);
      border: 1px solid #3a5470;
      border-top: 3px solid #6a9ab8;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      position: relative;
      overflow: hidden;
    }
    .site-header::after {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 45%;
      background: linear-gradient(180deg, rgba(255,255,255,0.07) 0%, transparent 100%);
      pointer-events: none;
    }

    .ascii-border {
      font-family: 'Comic Sans MS', 'Comic Sans', cursive;
      font-size: 11px;
      color: #3a5470;
      letter-spacing: 0;
      white-space: pre;
      user-select: none;
    }

    h1 {
      font-family: 'Comic Sans MS', 'Comic Sans', cursive;
      font-size: clamp(1.6rem, 4vw, 2.8rem);
      margin: 8px 0 6px;
      background: linear-gradient(90deg, #b87090, #c8a84a, #6a9e78, #5a88b8, #8a70b8, #b87090);
      background-size: 300% 100%;
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      animation: rainbow 7s linear infinite;
      filter: drop-shadow(0 1px 3px rgba(100,70,120,0.4));
    }
    @keyframes rainbow { 0% { background-position: 0% 50%; } 100% { background-position: 300% 50%; } }

    .tagline {
      font-size: 12px;
      color: #5a7890;
      margin: 4px 0 0;
      font-family: 'Comic Sans MS', 'Comic Sans', cursive;
      letter-spacing: 1px;
    }

    /* ===== PANEL ===== */
    .panel {
      background: linear-gradient(180deg, #1e3050 0%, #182840 100%);
      border: 1px solid #2d4060;
      border-top: 2px solid #3a5678;
      padding: 16px;
      margin-bottom: 18px;
      box-shadow: 0 2px 6px rgba(0,0,0,0.25);
      position: relative;
    }
    .panel::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 35%;
      background: linear-gradient(180deg, rgba(255,255,255,0.05) 0%, transparent 100%);
      pointer-events: none;
    }

    .panel-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px dashed #2d4060;
    }
    .panel-todos .panel-header   { border-bottom-color: #3a5830; }
    .panel-reminders .panel-header { border-bottom-color: #3a3058; }

    h2 {
      font-family: 'Comic Sans MS', 'Comic Sans', cursive;
      font-size: 1.15rem;
      margin: 0;
    }
    .panel-todos h2     { color: #a8c87a; }
    .panel-reminders h2 { color: #a880c0; }
    .panel-controls h2  { color: #7aaac8; }

    .section-label {
      font-family: 'Comic Sans MS', 'Comic Sans', cursive;
      font-size: 12px;
      color: #4a6888;
    }

    /* ===== CONTROLS ===== */
    .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }

    label {
      font-size: 11px;
      font-weight: bold;
      color: #6a8aaa;
      font-family: 'Comic Sans MS', 'Comic Sans', cursive;
    }

    input, select {
      border: 1px solid #2d4060;
      border-bottom: 2px solid #3a5678;
      background: #0f1e30;
      color: #cdd8e8;
      padding: 6px 10px;
      font-family: 'Comic Sans MS', cursive;
      font-size: 12px;
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    input:focus, select:focus {
      border-color: #5a88b8;
      box-shadow: 0 0 0 2px rgba(90,136,184,0.2);
    }
    select option { background: #0f1e30; }
    .token { width: 280px; max-width: 100%; }

    /* ===== TABLE SCROLL WRAPPER ===== */
    .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }

    /* ===== BUTTONS ===== */
    button {
      cursor: pointer;
      font-family: 'Comic Sans MS', 'Comic Sans', cursive;
      font-weight: bold;
      font-size: 12px;
      padding: 6px 14px;
      border-radius: 50px;
      border: none;
      position: relative;
      overflow: hidden;
      transition: transform 0.1s, box-shadow 0.1s;
      text-shadow: 0 1px 2px rgba(0,0,0,0.45);
      white-space: nowrap;
    }
    button::after {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 50%;
      background: rgba(255,255,255,0.22);
      border-radius: 50px 50px 0 0;
      pointer-events: none;
    }
    button:hover  { transform: translateY(-2px) scale(1.04); }
    button:active { transform: translateY(1px) scale(0.97); }

    button.primary {
      background: linear-gradient(180deg, #6a98c8 0%, #3a68a8 100%);
      box-shadow: 0 3px 10px rgba(58,104,168,0.4), inset 0 1px 0 rgba(255,255,255,0.28);
      color: #fff;
    }
    button.warn {
      background: linear-gradient(180deg, #c87878 0%, #a84848 100%);
      box-shadow: 0 3px 10px rgba(168,72,72,0.4), inset 0 1px 0 rgba(255,255,255,0.28);
      color: #fff;
    }
    button.neutral {
      background: linear-gradient(180deg, #7a8898 0%, #4a5868 100%);
      box-shadow: 0 3px 8px rgba(74,88,104,0.35), inset 0 1px 0 rgba(255,255,255,0.22);
      color: #fff;
    }
    button#reload {
      background: linear-gradient(180deg, #7ab888 0%, #4a8860 100%);
      box-shadow: 0 3px 10px rgba(74,136,96,0.4), inset 0 1px 0 rgba(255,255,255,0.32);
      color: #fff;
      font-size: 13px;
      padding: 7px 18px;
    }

    /* ===== TABLE ===== */
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th {
      text-align: left;
      padding: 8px;
      font-size: 10px;
      font-weight: bold;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      color: #4a6888;
      border-bottom: 1px solid #2d4060;
      font-family: 'Comic Sans MS', 'Comic Sans', cursive;
    }
    td {
      padding: 8px;
      vertical-align: middle;
      border-bottom: 1px solid #1a2a3c;
    }
    tr:hover td { background: rgba(255,255,255,0.025); }
    td input, td select {
      padding: 4px 7px;
      width: 100%;
      min-width: 80px;
      font-size: 11px;
    }

    /* ID badge */
    .id-badge {
      display: inline-block;
      background: linear-gradient(180deg, #6a5898 0%, #4a3878 100%);
      color: #d8c8f0;
      font-family: 'Comic Sans MS', 'Comic Sans', cursive;
      font-size: 11px;
      font-weight: bold;
      padding: 2px 8px;
      border-radius: 3px;
      box-shadow: 0 2px 4px rgba(74,56,120,0.4), inset 0 1px 0 rgba(255,255,255,0.18);
    }

    /* Status badges */
    .badge {
      display: inline-block;
      font-family: 'Comic Sans MS', 'Comic Sans', cursive;
      font-size: 10px;
      font-weight: bold;
      letter-spacing: 0.3px;
      padding: 2px 7px;
      border-radius: 2px;
    }
    .badge-open     { background: linear-gradient(180deg, #628a50 0%, #3a6030 100%); color:#d8f0d8; box-shadow: inset 0 1px 0 rgba(255,255,255,.18); }
    .badge-done     { background: linear-gradient(180deg, #607078 0%, #384048 100%); color:#c8d8d8; box-shadow: inset 0 1px 0 rgba(255,255,255,.15); }
    .badge-cancelled{ background: linear-gradient(180deg, #906050 0%, #684030 100%); color:#f0d8d0; box-shadow: inset 0 1px 0 rgba(255,255,255,.18); }
    .badge-pending  { background: linear-gradient(180deg, #987840 0%, #705820 100%); color:#f0e8c8; box-shadow: inset 0 1px 0 rgba(255,255,255,.18); }
    .badge-sent     { background: linear-gradient(180deg, #508898 0%, #306878 100%); color:#c8e8f0; box-shadow: inset 0 1px 0 rgba(255,255,255,.18); }

    /* ===== STATUS BAR ===== */
    .status-bar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      background: rgba(0,0,0,0.25);
      border: 1px solid #2d4060;
      font-size: 12px;
      font-family: 'Comic Sans MS', 'Comic Sans', cursive;
    }
    .status-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: #6a9e78;
      box-shadow: 0 0 5px #6a9e78;
      animation: pulse 2s ease-in-out infinite;
      flex-shrink: 0;
    }
    .status-dot.error { background: #a86060; box-shadow: 0 0 5px #a86060; }
    @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
    #status { color: #8aaac0; }

    /* ===== EMPTY STATE ===== */
    .empty-state {
      text-align: center;
      padding: 28px;
      color: #3a5470;
      font-size: 12px;
      font-family: 'Comic Sans MS', 'Comic Sans', cursive;
    }

    /* scrollbar */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: #0f1e30; }
    ::-webkit-scrollbar-thumb { background: #3a5478; }

    /* ===== MOBILE ===== */
    @media (max-width: 640px) {
      .wrap { padding: 12px 10px; }

      .ascii-border { display: none; }

      /* Controls: stack inputs vertically */
      .panel-controls .row {
        flex-direction: column;
        align-items: stretch;
        gap: 6px;
      }
      .panel-controls .row input,
      .panel-controls .row select {
        width: 100%;
      }
      .panel-controls .row button { align-self: flex-start; }

      /* Card layout — hide regular table header */
      table, thead, tbody, tr, th, td { display: block; }
      thead tr { display: none; }

      tbody tr {
        border: 1px solid #2d4060;
        border-top: 2px solid #3a5678;
        margin-bottom: 12px;
        padding: 8px 10px;
        background: linear-gradient(180deg, #1e3050 0%, #182840 100%);
      }

      td {
        display: flex;
        gap: 8px;
        align-items: flex-start;
        padding: 5px 0;
        border-bottom: 1px solid #182840;
      }
      td:last-child { border-bottom: none; }

      td::before {
        content: attr(data-label);
        font-family: 'Comic Sans MS', 'Comic Sans', cursive;
        font-size: 10px;
        font-weight: bold;
        color: #4a6888;
        min-width: 72px;
        flex-shrink: 0;
        padding-top: 5px;
      }

      td input, td select { flex: 1; min-width: 0; }

      /* Button group in action cell: wrap nicely */
      td .row {
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 0;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="site-header">
      <div class="ascii-border">+----------------------------------------------------+</div>
      <h1>** Todo &amp; Reminder Dashboard **</h1>
      <p class="tagline">-~- your personal productivity HQ -~-</p>
      <div class="ascii-border">+----------------------------------------------------+</div>
    </header>

    <div class="panel panel-controls">
      <div class="panel-header">
        <h2>//-- Controls --//</h2>
      </div>
      <div class="row">
        <label>[user]</label>
        <input id="userExternalId" value="${DEFAULT_USER_EXTERNAL_ID}" />
        <label>[token]</label>
        <input id="token" class="token" placeholder="Only needed if DASHBOARD_TOKEN is set" />
        <button id="reload">&gt;&gt; Reload All</button>
      </div>
      <div class="status-bar">
        <span class="status-dot" id="statusDot"></span>
        <span id="status">&gt; ready.</span>
      </div>
    </div>

    <div class="panel panel-todos">
      <div class="panel-header">
        <h2>//-- Todos --//</h2>
        <span class="section-label">[filter:]</span>
        <select id="todoStatusFilter">
          <option value="all">all</option>
          <option value="open" selected>open</option>
          <option value="done">done</option>
          <option value="cancelled">cancelled</option>
        </select>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr><th>[id]</th><th>[status]</th><th>[title]</th><th>[notes]</th><th>[priority]</th><th>[due]</th><th>[actions]</th></tr>
          </thead>
          <tbody id="todoRows"></tbody>
        </table>
      </div>
    </div>

    <div class="panel panel-reminders">
      <div class="panel-header">
        <h2>//-- Reminders --//</h2>
        <span class="section-label">[filter:]</span>
        <select id="reminderStatusFilter">
          <option value="all">all</option>
          <option value="pending" selected>pending</option>
          <option value="sent">sent</option>
          <option value="cancelled">cancelled</option>
        </select>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr><th>[id]</th><th>[status]</th><th>[text]</th><th>[time]</th><th>[timezone]</th><th>[recurrence]</th><th>[actions]</th></tr>
          </thead>
          <tbody id="reminderRows"></tbody>
        </table>
      </div>
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
      statusEl.textContent = '> ' + msg;
      statusEl.style.color = isError ? '#c08080' : '#8aaac0';
      if (statusDotEl) {
        statusDotEl.className = 'status-dot' + (isError ? ' error' : '');
      }
    }

    function statusBadge(status) {
      const map = {
        open:      'badge badge-open',
        done:      'badge badge-done',
        cancelled: 'badge badge-cancelled',
        pending:   'badge badge-pending',
        sent:      'badge badge-sent',
      };
      const cls = map[status] || 'badge badge-done';
      return '<span class="' + cls + '">[' + status.toUpperCase() + ']</span>';
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
        '<td data-label="[id]"><span class="id-badge">#' + todo.id + '</span></td>' +
        '<td data-label="[status]">' + statusBadge(todo.status) + '</td>' +
        '<td data-label="[title]"><input data-field="title" value="' + esc(todo.title) + '" /></td>' +
        '<td data-label="[notes]"><input data-field="notes" value="' + esc(todo.notes) + '" /></td>' +
        '<td data-label="[priority]"><select data-field="priority">' + priorityOptions + '</select></td>' +
        '<td data-label="[due]"><input data-field="dueAt" type="datetime-local" value="' + dueLocal + '" /></td>' +
        '<td data-label="[actions]"><div class="row">' +
        '<button data-action="saveTodo" class="primary">&gt;&gt; Save</button>' +
        '<button data-action="clearDue" class="neutral">-- Due</button>' +
        '<button data-action="clearNotes" class="neutral">-- Notes</button>' +
        '<button data-action="completeTodo" class="primary">++ Done</button>' +
        '<button data-action="cancelTodo" class="warn">xx Cancel</button>' +
        '</div></td>' +
        '</tr>';
    }

    function reminderRow(reminder) {
      const remindLocal = toLocalInputValue(reminder.remindAt);
      return '<tr data-id="' + reminder.id + '">' +
        '<td data-label="[id]"><span class="id-badge">#' + reminder.id + '</span></td>' +
        '<td data-label="[status]">' + statusBadge(reminder.status) + '</td>' +
        '<td data-label="[text]"><input data-field="text" value="' + esc(reminder.text) + '" /></td>' +
        '<td data-label="[time]"><input data-field="remindAt" type="datetime-local" value="' + remindLocal + '" /></td>' +
        '<td data-label="[timezone]"><input data-field="timezone" value="' + esc(reminder.timezone) + '" /></td>' +
        '<td data-label="[recurrence]"><input data-field="recurrenceRule" value="' + esc(reminder.recurrenceRule) + '" /></td>' +
        '<td data-label="[actions]"><div class="row">' +
        '<button data-action="saveReminder" class="primary">&gt;&gt; Save</button>' +
        '<button data-action="clearRecurrence" class="neutral">-- Clear</button>' +
        '<button data-action="cancelReminder" class="warn">xx Cancel</button>' +
        '</div></td>' +
        '</tr>';
    }

    async function loadTodos() {
      const status = document.getElementById('todoStatusFilter').value;
      const qs = new URLSearchParams({ userExternalId: userId(), limit: '200' });
      if (status !== 'all') qs.set('status', status);
      const data = await api('/api/todos?' + qs.toString(), { method: 'GET', headers: {} });
      todoRowsEl.innerHTML = data.todos.map(todoRow).join('') || '<tr><td colspan="7"><div class="empty-state">-- no todos found --</div></td></tr>';
    }

    async function loadReminders() {
      const status = document.getElementById('reminderStatusFilter').value;
      const qs = new URLSearchParams({ userExternalId: userId(), limit: '200' });
      if (status !== 'all') qs.set('status', status);
      const data = await api('/api/reminders?' + qs.toString(), { method: 'GET', headers: {} });
      reminderRowsEl.innerHTML = data.reminders.map(reminderRow).join('') || '<tr><td colspan="7"><div class="empty-state">-- no reminders found --</div></td></tr>';
    }

    async function reloadAll() {
      setStatus('Loading...');
      try {
        await Promise.all([loadTodos(), loadReminders()]);
        setStatus('all loaded. looking good!');
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
          setStatus('todo #' + id + ' saved.');
        } else if (btn.dataset.action === 'clearDue') {
          await api('/api/todos/' + id, { method: 'PATCH', body: JSON.stringify({ userExternalId: userId(), clearDueAt: true }) });
          setStatus('todo #' + id + ' due date cleared.');
        } else if (btn.dataset.action === 'clearNotes') {
          await api('/api/todos/' + id, { method: 'PATCH', body: JSON.stringify({ userExternalId: userId(), clearNotes: true }) });
          setStatus('todo #' + id + ' notes cleared.');
        } else if (btn.dataset.action === 'completeTodo') {
          await api('/api/todos/' + id + '/complete', { method: 'POST', body: JSON.stringify({ userExternalId: userId() }) });
          setStatus('todo #' + id + ' marked done! nice work.');
        } else if (btn.dataset.action === 'cancelTodo') {
          await api('/api/todos/' + id + '/cancel', { method: 'POST', body: JSON.stringify({ userExternalId: userId() }) });
          setStatus('todo #' + id + ' cancelled.');
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
          setStatus('reminder #' + id + ' updated.');
        } else if (btn.dataset.action === 'clearRecurrence') {
          await api('/api/reminders/' + id, { method: 'PATCH', body: JSON.stringify({ userExternalId: userId(), clearRecurrenceRule: true }) });
          setStatus('reminder #' + id + ' recurrence cleared.');
        } else if (btn.dataset.action === 'cancelReminder') {
          await api('/api/reminders/' + id + '/cancel', { method: 'POST', body: JSON.stringify({ userExternalId: userId() }) });
          setStatus('reminder #' + id + ' cancelled.');
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
