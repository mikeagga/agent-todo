import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { URL } from "node:url";
import { createBackbone } from "../index.js";
import { resolveDayRange, resolveTimeExpression } from "../time/protocol.js";

const PORT = Number.parseInt(process.env.DASHBOARD_PORT ?? process.env.PORT ?? "8787", 10) || 8787;
const HOST = process.env.DASHBOARD_HOST ?? "0.0.0.0";
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN?.trim();
const DEFAULT_USER_EXTERNAL_ID = process.env.TODO_USER_ID ?? "local-user";
const API_CAPABILITIES_VERSION = "2026-04-19";
const REMINDER_PAST_GRACE_SECONDS = Number.parseInt(process.env.REMINDER_PAST_GRACE_SECONDS ?? "60", 10) || 60;

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
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>*** Agent Todo Dashboard ***</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Comic Sans MS', 'Marker Felt', 'Trebuchet MS', cursive, sans-serif;
      background: #ffb3d9 url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="%23ffcce6" width="50" height="50"/><rect fill="%23ffe6f2" x="50" width="50" height="50"/><rect fill="%23ffe6f2" y="50" width="50" height="50"/><rect fill="%23ffcce6" x="50" y="50" width="50" height="50"/></svg>');
      color: #000080;
      padding: 10px;
      min-height: 100vh;
    }
    .ascii-banner {
      background: #ff66cc;
      color: yellow;
      padding: 15px;
      border: 5px ridge #ff1493;
      margin-bottom: 15px;
      text-align: center;
      font-family: monospace;
      white-space: pre;
      line-height: 1.2;
      font-size: 11px;
    }
    marquee {
      background: #ffff00;
      border: 3px solid #ff0000;
      padding: 8px;
      margin-bottom: 10px;
      font-weight: bold;
      color: #ff0000;
    }
    h1 {
      font-size: 28px;
      margin-bottom: 5px;
      text-align: center;
      background: #000;
      border: 3px double #ff0099;
      padding: 15px;
      overflow: hidden;
    }
    .flame-text {
      font-weight: bold;
      background: linear-gradient(180deg, #fff000 0%, #ff8800 30%, #ff0000 60%, #8b0000 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      animation: flames 2s ease-in-out infinite alternate;
      text-shadow: 0 0 20px rgba(255, 136, 0, 0.8);
      display: inline-block;
    }
    @keyframes flames {
      0% {
        background: linear-gradient(180deg, #fff000 0%, #ff8800 30%, #ff0000 60%, #8b0000 100%);
        filter: brightness(1) hue-rotate(0deg);
      }
      25% {
        background: linear-gradient(180deg, #ffff00 0%, #ff6600 30%, #ff2200 60%, #aa0000 100%);
        filter: brightness(1.2) hue-rotate(5deg);
      }
      50% {
        background: linear-gradient(180deg, #fff200 0%, #ff9900 30%, #ff1100 60%, #990000 100%);
        filter: brightness(0.9) hue-rotate(-5deg);
      }
      75% {
        background: linear-gradient(180deg, #ffee00 0%, #ff7700 30%, #ff3300 60%, #bb0000 100%);
        filter: brightness(1.1) hue-rotate(3deg);
      }
      100% {
        background: linear-gradient(180deg, #fff000 0%, #ff8800 30%, #ff0000 60%, #8b0000 100%);
        filter: brightness(1) hue-rotate(0deg);
      }
    }
    h2 {
      font-size: 18px;
      margin: 15px 0 8px 0;
      color: #0000ff;
      background: #ccffff;
      border: 2px solid #0000ff;
      padding: 8px;
      text-decoration: underline;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
      background: #ffffff;
      border: 5px outset #ff6bda;
      padding: 15px;
    }
    .row {
      display: flex;
      gap: 8px;
      margin-bottom: 10px;
      flex-wrap: nowrap;
    }
    .status-bar {
      background: #ffff99;
      border: 3px groove #ff9900;
      padding: 10px;
      margin-bottom: 15px;
      font-weight: bold;
      font-size: 13px;
    }
    .status-dot {
      width: 10px;
      height: 10px;
      background: #00ff00;
      display: inline-block;
      border: 1px solid #000;
      animation: blink 1s ease-in-out infinite;
    }
    .status-dot.error { background: #ff0000; }
    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
    .table-scroll {
      overflow-x: auto;
      background: #e6f2ff;
      border: 3px inset #0066cc;
      padding: 8px;
      margin-bottom: 15px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      border: 2px solid #000;
    }
    th, td {
      padding: 6px 8px;
      text-align: left;
      border: 1px solid #999;
    }
    th {
      font-weight: bold;
      color: #ffffff;
      font-size: 11px;
      background: #0066cc;
      text-align: center;
    }
    tr:nth-child(even) { background: #ffffcc; }
    tr:nth-child(odd) { background: #ffffff; }
    tr:hover { background: #ffccff !important; }
    input, select, button {
      font-family: inherit;
      font-size: 12px;
      padding: 4px 8px;
      border: 2px inset #999;
      background: #ffffff;
      color: #000;
    }
    input:focus, select:focus {
      outline: 1px dotted #000;
      background: #ffffcc;
    }
    button {
      cursor: pointer;
      background: #cccccc;
      border: 2px outset #999;
      color: #000;
      font-weight: bold;
      white-space: nowrap;
      padding: 5px 12px;
    }
    button:hover { 
      background: #dddddd;
    }
    button:active { 
      border-style: inset;
    }
    button.danger { 
      background: #ff9999;
    }
    button.danger:hover { 
      background: #ffbbbb;
    }
    button.small {
      font-size: 10px;
      padding: 3px 8px;
    }
    label {
      display: block;
      font-size: 10px;
      font-weight: bold;
      color: #000080;
      margin-bottom: 3px;
    }
    .field {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .field.grow { flex: 1; }
    .field.auto { flex: 0 0 auto; }
    .priority-urgent { color: #ff0000 !important; font-weight: bold; }
    .priority-high { color: #ff6600 !important; font-weight: bold; }
    .priority-normal { color: #000080; }
    .priority-low { color: #666666; }
    code {
      background: #f0f0f0;
      padding: 2px 4px;
      font-size: 11px;
      font-family: 'Courier New', monospace;
      border: 1px solid #ccc;
    }
    td.row {
      display: flex;
      gap: 5px;
      align-items: flex-start;
      flex-wrap: nowrap;
    }
    td .field-label {
      font-size: 10px;
      font-weight: bold;
      color: #000080;
      min-width: 60px;
      flex-shrink: 0;
      padding-top: 3px;
    }
    td input, td select { flex: 1; min-width: 0; }
    td .row {
      flex-wrap: wrap;
      gap: 4px;
      margin-bottom: 0;
    }
    .footer {
      text-align: center;
      margin-top: 20px;
      padding: 15px;
      background: #ffccff;
      border: 3px double #ff00ff;
      font-size: 11px;
      color: #000080;
    }
    .footer a {
      color: #0000ff;
      text-decoration: underline;
      font-weight: bold;
    }
    .footer a:hover {
      color: #ff0000;
    }
    .counter {
      background: #000;
      color: #00ff00;
      padding: 5px 10px;
      border: 2px ridge #666;
      font-family: monospace;
      display: inline-block;
      margin: 10px 0;
    }
    /* Mobile responsive */
    @media (max-width: 768px) {
      body {
        padding: 5px;
      }
      .container {
        padding: 10px;
        border-width: 3px;
      }
      h1 {
        font-size: 20px;
        padding: 10px;
      }
      h2 {
        font-size: 16px;
        padding: 6px;
      }
      marquee {
        font-size: 11px;
        padding: 5px;
      }
      .ascii-banner {
        font-size: 8px;
        padding: 10px;
        overflow-x: auto;
      }
      .row {
        flex-wrap: wrap;
      }
      .field {
        min-width: 100%;
        margin-bottom: 8px;
      }
      .field.auto {
        min-width: 100%;
      }
      input, select, button {
        width: 100%;
        font-size: 14px;
        padding: 8px;
      }
      button {
        margin-top: 5px;
      }
      table {
        font-size: 10px;
      }
      th, td {
        padding: 4px 3px;
        font-size: 10px;
      }
      .table-scroll {
        padding: 5px;
      }
      .counter {
        font-size: 11px;
      }
      .footer {
        font-size: 10px;
        padding: 10px;
      }
      .status-bar {
        font-size: 11px;
        padding: 8px;
      }
    }
    @media (max-width: 480px) {
      h1 {
        font-size: 18px;
      }
      .ascii-banner {
        font-size: 6px;
      }
      td.row {
        flex-direction: column;
      }
      button.small {
        width: 100%;
        margin-bottom: 3px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="ascii-banner">
 _____ ___  ____   ___    ____    _    ____  _   _ ____   ___    _    ____  ____  
|_   _/ _ \\|  _ \\ / _ \\  |  _ \\  / \\  / ___|| | | | __ ) / _ \\  / \\  |  _ \\|  _ \\ 
  | || | | | | | | | | | | | | |/ _ \\ \\___ \\| |_| |  _ \\| | | |/ _ \\ | |_) | | | |
  | || |_| | |_| | |_| | | |_| / ___ \\ ___) |  _  | |_) | |_| / ___ \\|  _ <| |_| |
  |_| \\___/|____/ \\___/  |____/_/   \\_\\____/|_| |_|____/ \\___/_/   \\_\\_| \\_\\____/ 
    </div>
    <marquee>Welcome to my Todo Dashboard! * This site best viewed in Netscape Navigator * Last updated: 2026-04-18</marquee>
    <h1><img src="/cooltext.gif" alt="TODO DASHBOARD" style="max-width: 100%; height: auto;"></h1>
    <center><div class="counter">VISITOR #001337</div></center>

    <table width="100%" border="0" cellpadding="5" bgcolor="#ffff99">
      <tr>
        <td>
          <div class="status-bar">
            <span class="status-dot"></span>
            <span id="statusText">*** System Status: READY ***</span>
          </div>
        </td>
      </tr>
    </table>

    <table width="100%" border="2" cellpadding="8" bgcolor="#ffffcc" style="margin-bottom: 15px;">
      <tr>
        <td>
          <b>*** LOGIN CREDENTIALS ***</b><br>
          <div class="row" style="margin-top: 8px;">
            <div class="field auto">
              <label>Dashboard Token</label>
              <input id="dashboardToken" type="password" placeholder="Enter token (if required)" style="min-width: 200px;" />
            </div>
            <div class="field auto">
              <label>User ID</label>
              <input id="userId" type="text" value="demo-user" />
            </div>
            <div class="field auto" style="justify-content: flex-end;">
              <label>&nbsp;</label>
              <button id="reload">Reload All</button>
            </div>
          </div>
        </td>
      </tr>
    </table>

    <h2>>>> MY TODOS <<<</h2>
    <div class="row">
      <div class="field grow">
        <label>Title</label>
        <input id="todoTitle" type="text" placeholder="Task title" />
      </div>
      <div class="field grow">
        <label>Notes</label>
        <input id="todoNotes" type="text" placeholder="Optional notes" />
      </div>
      <div class="field auto">
        <label>Priority</label>
        <select id="todoPriority">
          <option value="low">low</option>
          <option value="normal" selected>normal</option>
          <option value="high">high</option>
          <option value="urgent">urgent</option>
        </select>
      </div>
      <div class="field auto">
        <label>Due</label>
        <input id="todoDue" type="datetime-local" />
      </div>
      <div class="field auto" style="justify-content: flex-end;">
        <label>&nbsp;</label>
        <button id="createTodo">+ Create Todo</button>
      </div>
    </div>

    <div class="row">
      <div class="field auto">
        <label>Filter Status</label>
        <select id="todoStatusFilter">
          <option value="all">all</option>
          <option value="open" selected>open</option>
          <option value="done">done</option>
          <option value="cancelled">cancelled</option>
        </select>
      </div>
    </div>

    <div class="table-scroll">
      <table>
        <thead>
          <tr><th>[id]</th><th>[status]</th><th>[title]</th><th>[notes]</th><th>[priority]</th><th>[due]</th><th>[actions]</th></tr>
        </thead>
        <tbody id="todoRows"></tbody>
      </table>
    </div>

    <h2>>>> MY REMINDERS <<<</h2>
    <div class="row">
      <div class="field grow">
        <label>Text</label>
        <input id="reminderText" type="text" placeholder="Reminder text" />
      </div>
      <div class="field auto">
        <label>Remind At</label>
        <input id="reminderTime" type="datetime-local" />
      </div>
      <div class="field auto" style="justify-content: flex-end;">
        <label>&nbsp;</label>
        <button id="createReminder">+ Create Reminder</button>
      </div>
    </div>

    <div class="row">
      <div class="field auto">
        <label>Filter Status</label>
        <select id="reminderStatusFilter">
          <option value="all">all</option>
          <option value="pending" selected>pending</option>
          <option value="sent">sent</option>
          <option value="cancelled">cancelled</option>
        </select>
      </div>
    </div>

    <div class="table-scroll">
      <table>
        <thead>
          <tr><th>[id]</th><th>[status]</th><th>[text]</th><th>[remindAt]</th><th>[recurrence]</th><th>[todoId]</th><th>[actions]</th></tr>
        </thead>
        <tbody id="reminderRows"></tbody>
      </table>
    </div>

    <hr size="5" color="#ff00ff">
    <div class="footer">
      <p><b>*** Made with love for organizing your life! ***</b></p>
      <p style="margin-top: 5px;"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==" width="1" height="1" alt=""> Powered by Agent Todo <img src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==" width="1" height="1" alt=""></p>
      <p><a href="https://github.com" target="_blank">Visit us!</a> | <a href="#">Guestbook</a> | <a href="#">Web Rings</a></p>
      <p style="font-size: 9px; margin-top: 10px;">This page is best viewed at 800x600 resolution</p>
    </div>
  </div>

<script>
  const statusEl = document.getElementById('statusText');
  const statusDotEl = document.querySelector('.status-dot');
  const userIdInput = document.getElementById('userId');
  const tokenInput = document.getElementById('dashboardToken');
  const params = new URLSearchParams(window.location.search);

  const savedToken = localStorage.getItem('dashboardToken') || '';
  const savedUserId = localStorage.getItem('dashboardUserId') || '';
  const tokenFromUrl = params.get('token') || '';
  const userFromUrl = params.get('userExternalId') || params.get('userId') || '';

  if (tokenFromUrl || userFromUrl) {
    params.delete('token');
    params.delete('userExternalId');
    params.delete('userId');
    const next = params.toString();
    history.replaceState(null, '', next ? ('?' + next) : window.location.pathname);
  }

  if (tokenFromUrl) {
    tokenInput.value = tokenFromUrl;
    localStorage.setItem('dashboardToken', tokenFromUrl);
  } else if (savedToken) {
    tokenInput.value = savedToken;
  }

  if (userFromUrl) {
    userIdInput.value = userFromUrl;
    localStorage.setItem('dashboardUserId', userFromUrl);
  } else if (savedUserId) {
    userIdInput.value = savedUserId;
  }

  tokenInput.addEventListener('change', () => {
    const token = tokenInput.value.trim();
    if (token) localStorage.setItem('dashboardToken', token);
    else localStorage.removeItem('dashboardToken');
  });

  userIdInput.addEventListener('change', () => {
    const uid = userIdInput.value.trim();
    if (uid) localStorage.setItem('dashboardUserId', uid);
    else localStorage.removeItem('dashboardUserId');
  });

  function userId() { return userIdInput.value || 'demo-user'; }
  function getToken() { return tokenInput.value.trim(); }

  function setStatus(msg, isError = false) {
    statusEl.textContent = '*** ' + msg + ' ***';
    statusEl.style.color = isError ? '#ff0000' : '#000080';
    statusDotEl.className = 'status-dot' + (isError ? ' error' : '');
  }

  async function api(path, options = {}) {
    const headers = { ...options.headers };
    if (options.body) headers['Content-Type'] = 'application/json';
    const token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(path, { ...options, headers });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        throw new Error(data.error || 'Unauthorized: paste DASHBOARD_TOKEN in the token field.');
      }
      throw new Error(data.error || ('HTTP ' + res.status));
    }
    return res.json();
  }

  async function loadTodos() {
    const filter = document.getElementById('todoStatusFilter').value;
    const params = new URLSearchParams({ userExternalId: userId() });
    if (filter !== 'all') params.set('status', filter);
    const todosRes = await api('/api/todos?' + params);
    const todos = Array.isArray(todosRes?.todos) ? todosRes.todos : [];
    const tbody = document.getElementById('todoRows');
    tbody.innerHTML = '';
    for (const t of todos) {
      const tr = tbody.insertRow();
      tr.innerHTML = \`
        <td>\${t.id}</td>
        <td class="priority-\${t.status || 'normal'}">\${t.status}</td>
        <td>\${t.title}</td>
        <td>\${t.notes || ''}</td>
        <td class="priority-\${t.priority || 'normal'}">\${t.priority || 'normal'}</td>
        <td><code>\${t.dueAt || ''}</code></td>
        <td class="row">
          \${t.status === 'open' ? '<button class="small" data-action="completeTodo" data-id="' + t.id + '">Complete</button>' : ''}
          <button class="small danger" data-action="cancelTodo" data-id="\${t.id}">Cancel</button>
        </td>
      \`;
    }
  }

  async function loadReminders() {
    const filter = document.getElementById('reminderStatusFilter').value;
    const params = new URLSearchParams({ userExternalId: userId() });
    if (filter !== 'all') params.set('status', filter);
    const remindersRes = await api('/api/reminders?' + params);
    const reminders = Array.isArray(remindersRes?.reminders) ? remindersRes.reminders : [];
    const tbody = document.getElementById('reminderRows');
    tbody.innerHTML = '';
    for (const r of reminders) {
      const tr = tbody.insertRow();
      tr.innerHTML = \`
        <td>\${r.id}</td>
        <td>\${r.status}</td>
        <td>\${r.text}</td>
        <td><code>\${r.remindAt}</code></td>
        <td><code>\${r.recurrenceRule || ''}</code></td>
        <td>\${r.todoId || ''}</td>
        <td class="row">
          \${r.status === 'pending' ? '<button class="small danger" data-action="cancelReminder" data-id="' + r.id + '">Cancel</button>' : ''}
        </td>
      \`;
    }
  }

  async function reloadAll() {
    try {
      setStatus('Loading...');
      await Promise.all([loadTodos(), loadReminders()]);
      setStatus('System Status: READY');
    } catch (err) {
      setStatus(err.message || String(err), true);
    }
  }

  document.getElementById('reload').onclick = reloadAll;
  document.getElementById('todoStatusFilter').onchange = loadTodos;
  document.getElementById('reminderStatusFilter').onchange = loadReminders;

  document.getElementById('createTodo').onclick = async () => {
    try {
      const title = document.getElementById('todoTitle').value.trim();
      const notes = document.getElementById('todoNotes').value.trim();
      const priority = document.getElementById('todoPriority').value;
      const due = document.getElementById('todoDue').value;
      if (!title) return setStatus('Title is required.', true);
      const body = { title, userExternalId: userId(), priority };
      if (notes) body.notes = notes;
      if (due) body.dueAt = new Date(due).toISOString();
      await api('/api/todos', { method: 'POST', body: JSON.stringify(body) });
      document.getElementById('todoTitle').value = '';
      document.getElementById('todoNotes').value = '';
      document.getElementById('todoDue').value = '';
      setStatus('Todo created!');
      await loadTodos();
    } catch (err) {
      setStatus(err.message || String(err), true);
    }
  };

  document.getElementById('createReminder').onclick = async () => {
    try {
      const text = document.getElementById('reminderText').value.trim();
      const time = document.getElementById('reminderTime').value;
      if (!text) return setStatus('Text is required.', true);
      if (!time) return setStatus('Remind time is required.', true);
      const body = { text, remindAt: new Date(time).toISOString(), userExternalId: userId() };
      await api('/api/reminders', { method: 'POST', body: JSON.stringify(body) });
      document.getElementById('reminderText').value = '';
      document.getElementById('reminderTime').value = '';
      setStatus('Reminder created!');
      await loadReminders();
    } catch (err) {
      setStatus(err.message || String(err), true);
    }
  };

  document.body.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    e.preventDefault();
    const id = parseInt(btn.dataset.id, 10);
    try {
      if (btn.dataset.action === 'completeTodo') {
        await api('/api/todos/' + id + '/complete', { method: 'POST', body: JSON.stringify({ userExternalId: userId() }) });
        setStatus('Todo #' + id + ' completed!');
      } else if (btn.dataset.action === 'cancelTodo') {
        await api('/api/todos/' + id + '/cancel', { method: 'POST', body: JSON.stringify({ userExternalId: userId() }) });
        setStatus('Todo #' + id + ' cancelled.');
      } else if (btn.dataset.action === 'cancelReminder') {
        await api('/api/reminders/' + id + '/cancel', { method: 'POST', body: JSON.stringify({ userExternalId: userId() }) });
        setStatus('Reminder #' + id + ' cancelled.');
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

    if (req.method === "GET" && url.pathname === "/cooltext.gif") {
      try {
        const gifPath = join(process.cwd(), "cooltext506343687696721.gif");
        const gifData = await readFile(gifPath);
        res.writeHead(200, { "Content-Type": "image/gif" });
        res.end(gifData);
        return;
      } catch (err) {
        return sendJson(res, 404, { ok: false, error: "GIF not found" });
      }
    }

    if (!isAuthorized(req)) {
      return unauthorized(res);
    }

    if (req.method === "GET" && url.pathname === "/api/meta/capabilities") {
      return sendJson(res, 200, {
        ok: true,
        capabilitiesVersion: API_CAPABILITIES_VERSION,
        time: {
          canonicalStorage: "utc-iso8601",
          endpoints: ["/api/time/resolve-expression", "/api/time/day-range"],
        },
        endpoints: {
          todos: [
            "GET /api/todos",
            "GET /api/todos/search",
            "GET /api/todos/by-day",
            "GET /api/todos/:id",
            "POST /api/todos",
            "PATCH /api/todos/:id",
            "POST /api/todos/:id/complete",
            "POST /api/todos/:id/cancel",
          ],
          reminders: [
            "GET /api/reminders",
            "GET /api/reminders/due",
            "GET /api/reminders/by-day",
            "POST /api/reminders",
            "PATCH /api/reminders/:id",
            "POST /api/reminders/:id/cancel",
          ],
        },
      });
    }

    if (req.method === "POST" && url.pathname === "/api/time/resolve-expression") {
      const body = await readJsonBody(req);
      const expression = normalizeOptionalString((body as { expression?: unknown }).expression);
      const timezone = normalizeOptionalString((body as { timezone?: unknown }).timezone);
      const requireTime = (body as { requireTime?: unknown }).requireTime === true;
      const referenceIso = normalizeOptionalString((body as { referenceIso?: unknown }).referenceIso);

      if (!expression) {
        return sendJson(res, 400, { ok: false, error: "expression is required" });
      }

      const resolution = resolveTimeExpression({ expression, timezone, requireTime, referenceIso });
      return sendJson(res, 200, { ok: true, resolution });
    }

    if (req.method === "POST" && url.pathname === "/api/time/day-range") {
      const body = await readJsonBody(req);
      const day = normalizeOptionalString((body as { day?: unknown }).day);
      const timezone = normalizeOptionalString((body as { timezone?: unknown }).timezone);
      const range = resolveDayRange({ day, timezone });
      return sendJson(res, 200, { ok: true, range });
    }

    if (req.method === "GET" && url.pathname === "/api/todos") {
      const userExternalId = url.searchParams.get("userExternalId") ?? DEFAULT_USER_EXTERNAL_ID;
      const status = url.searchParams.get("status") || undefined;
      const dueBefore = normalizeOptionalString(url.searchParams.get("dueBefore"));
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "200", 10) || 200;
      const todos = backbone.todoService.listTodos({
        userExternalId,
        status: status === "all" ? undefined : (status as "open" | "done" | "cancelled" | undefined),
        dueBefore,
        limit,
      });
      return sendJson(res, 200, { ok: true, todos });
    }

    if (req.method === "GET" && url.pathname === "/api/todos/search") {
      const userExternalId = url.searchParams.get("userExternalId") ?? DEFAULT_USER_EXTERNAL_ID;
      const query = normalizeOptionalString(url.searchParams.get("query"));
      const includeDone = (url.searchParams.get("includeDone") ?? "true").toLowerCase() !== "false";
      const includeCancelled = (url.searchParams.get("includeCancelled") ?? "false").toLowerCase() === "true";
      const olderThanDays = Number.parseInt(url.searchParams.get("olderThanDays") ?? "", 10);
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "200", 10) || 200;
      const sortRaw = url.searchParams.get("sort") ?? "recent";
      const sort = (sortRaw === "oldest" || sortRaw === "due" ? sortRaw : "recent") as "recent" | "oldest" | "due";

      const todos = backbone.todoService.searchTodos({
        userExternalId,
        query,
        includeDone,
        includeCancelled,
        olderThanDays: Number.isFinite(olderThanDays) ? olderThanDays : undefined,
        limit,
        sort,
      });
      return sendJson(res, 200, { ok: true, todos });
    }

    if (req.method === "GET" && url.pathname === "/api/todos/by-day") {
      const day = normalizeOptionalString(url.searchParams.get("day"));
      const timezone = normalizeOptionalString(url.searchParams.get("timezone"));
      const userExternalId = url.searchParams.get("userExternalId") ?? DEFAULT_USER_EXTERNAL_ID;
      const status = url.searchParams.get("status") || undefined;
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "200", 10) || 200;
      const range = resolveDayRange({ day, timezone });
      if (!range.ok || !range.fromUtcIso || !range.toUtcIso) {
        return sendJson(res, 400, { ok: false, error: range.reason ?? "Invalid day range" });
      }

      const todos = backbone.todoService
        .listTodos({
          userExternalId,
          status: status === "all" ? undefined : (status as "open" | "done" | "cancelled" | undefined),
          dueBefore: range.toUtcIso,
          limit,
        })
        .filter((todo) => !!todo.dueAt && Date.parse(todo.dueAt) >= Date.parse(range.fromUtcIso!));

      return sendJson(res, 200, {
        ok: true,
        day: range.day,
        timezone: range.timezoneUsed,
        fromUtc: range.fromUtcIso,
        toUtc: range.toUtcIso,
        todos,
      });
    }

    const todoGet = req.method === "GET" ? url.pathname.match(/^\/api\/todos\/(\d+)$/) : null;
    if (todoGet) {
      const todoId = Number(todoGet[1]);
      const userExternalId = url.searchParams.get("userExternalId") ?? DEFAULT_USER_EXTERNAL_ID;
      const todo = backbone.todoService.getTodoById(userExternalId, todoId);
      return sendJson(res, 200, { ok: true, todo });
    }

    if (req.method === "POST" && url.pathname === "/api/todos") {
      const body = await readJsonBody(req);
      const userExternalId = normalizeOptionalString((body as { userExternalId?: unknown }).userExternalId) ??
        DEFAULT_USER_EXTERNAL_ID;
      const todo = backbone.todoService.addTodo({
        userExternalId,
        title: normalizeOptionalString((body as { title?: unknown }).title) ?? "",
        notes: typeof (body as { notes?: unknown }).notes === "string" ? (body as { notes: string }).notes : undefined,
        dueAt: normalizeOptionalString((body as { dueAt?: unknown }).dueAt),
        priority: normalizeOptionalString((body as { priority?: unknown }).priority) as
          | "low"
          | "normal"
          | "high"
          | "urgent"
          | undefined,
        source: normalizeOptionalString((body as { source?: unknown }).source) ?? "api",
      });
      return sendJson(res, 200, { ok: true, todo });
    }

    if (req.method === "GET" && url.pathname === "/api/reminders") {
      const userExternalId = url.searchParams.get("userExternalId") ?? DEFAULT_USER_EXTERNAL_ID;
      const status = url.searchParams.get("status") || undefined;
      const todoId = Number.parseInt(url.searchParams.get("todoId") ?? "", 10);
      const from = normalizeOptionalString(url.searchParams.get("from"));
      const to = normalizeOptionalString(url.searchParams.get("to"));
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "200", 10) || 200;
      const reminders = backbone.reminderService.listReminders({
        userExternalId,
        status: status === "all" ? undefined : (status as "pending" | "sent" | "cancelled" | undefined),
        todoId: Number.isFinite(todoId) ? todoId : undefined,
        from,
        to,
        limit,
      });
      return sendJson(res, 200, { ok: true, reminders });
    }

    if (req.method === "GET" && url.pathname === "/api/reminders/due") {
      const userExternalId = url.searchParams.get("userExternalId") ?? DEFAULT_USER_EXTERNAL_ID;
      const asOf = normalizeOptionalString(url.searchParams.get("asOf")) ?? new Date().toISOString();
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "200", 10) || 200;
      const reminders = backbone.reminderService.listDueReminders({ userExternalId, asOf, limit });
      return sendJson(res, 200, { ok: true, reminders });
    }

    if (req.method === "GET" && url.pathname === "/api/reminders/by-day") {
      const day = normalizeOptionalString(url.searchParams.get("day"));
      const timezone = normalizeOptionalString(url.searchParams.get("timezone"));
      const userExternalId = url.searchParams.get("userExternalId") ?? DEFAULT_USER_EXTERNAL_ID;
      const status = url.searchParams.get("status") || undefined;
      const todoId = Number.parseInt(url.searchParams.get("todoId") ?? "", 10);
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "200", 10) || 200;
      const range = resolveDayRange({ day, timezone });
      if (!range.ok || !range.fromUtcIso || !range.toUtcIso) {
        return sendJson(res, 400, { ok: false, error: range.reason ?? "Invalid day range" });
      }

      const reminders = backbone.reminderService.listReminders({
        userExternalId,
        status: status === "all" ? undefined : (status as "pending" | "sent" | "cancelled" | undefined),
        todoId: Number.isFinite(todoId) ? todoId : undefined,
        from: range.fromUtcIso,
        to: range.toUtcIso,
        limit,
      });

      return sendJson(res, 200, {
        ok: true,
        day: range.day,
        timezone: range.timezoneUsed,
        fromUtc: range.fromUtcIso,
        toUtc: range.toUtcIso,
        reminders,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/reminders") {
      const body = await readJsonBody(req);
      const userExternalId = normalizeOptionalString((body as { userExternalId?: unknown }).userExternalId) ??
        DEFAULT_USER_EXTERNAL_ID;
      const remindAtDirect = normalizeOptionalString((body as { remindAt?: unknown }).remindAt);
      const timeExpression = normalizeOptionalString((body as { timeExpression?: unknown }).timeExpression);
      const offsetMinutesFromNow =
        typeof (body as { offsetMinutesFromNow?: unknown }).offsetMinutesFromNow === "number"
          ? (body as { offsetMinutesFromNow: number }).offsetMinutesFromNow
          : undefined;
      const timezone = normalizeOptionalString((body as { timezone?: unknown }).timezone);

      const modeCount = [remindAtDirect ? 1 : 0, timeExpression ? 1 : 0, offsetMinutesFromNow !== undefined ? 1 : 0].reduce(
        (sum, n) => sum + n,
        0,
      );
      if (modeCount > 1) {
        return sendJson(res, 400, { ok: false, error: "Use only one of remindAt, timeExpression, or offsetMinutesFromNow" });
      }

      let remindAt = remindAtDirect;
      let timezoneFinal = timezone;
      if (!remindAt && offsetMinutesFromNow !== undefined) {
        if (!Number.isFinite(offsetMinutesFromNow) || offsetMinutesFromNow <= 0 || offsetMinutesFromNow > 10080) {
          return sendJson(res, 400, { ok: false, error: "offsetMinutesFromNow must be between 1 and 10080" });
        }
        remindAt = new Date(Date.now() + offsetMinutesFromNow * 60 * 1000).toISOString();
      }
      if (!remindAt && timeExpression) {
        const resolved = resolveTimeExpression({ expression: timeExpression, timezone, requireTime: true });
        if (!resolved.ok || !resolved.isoUtc || resolved.needsClarification) {
          return sendJson(res, 400, {
            ok: false,
            error: resolved.reason ?? "Could not resolve reminder time",
            details: resolved,
          });
        }
        remindAt = resolved.isoUtc;
        if (!timezoneFinal && resolved.timezoneUsed) timezoneFinal = resolved.timezoneUsed;
      }

      if (!remindAt) {
        return sendJson(res, 400, { ok: false, error: "remindAt or timeExpression is required" });
      }

      const remindAtMs = Date.parse(remindAt);
      if (!Number.isFinite(remindAtMs)) {
        return sendJson(res, 400, { ok: false, error: "Invalid remindAt" });
      }

      const nowMs = Date.now();
      const graceMs = REMINDER_PAST_GRACE_SECONDS * 1000;
      if (remindAtMs < nowMs - graceMs) {
        return sendJson(res, 400, {
          ok: false,
          error: `remindAt is in the past (more than ${REMINDER_PAST_GRACE_SECONDS}s). Please provide a future time.`,
        });
      }

      const reminder = backbone.reminderService.addReminder({
        userExternalId,
        todoId: typeof (body as { todoId?: unknown }).todoId === "number"
          ? ((body as { todoId: number }).todoId)
          : undefined,
        text: normalizeOptionalString((body as { text?: unknown }).text) ?? "",
        remindAt,
        timezone: timezoneFinal,
        recurrenceRule: normalizeOptionalString((body as { recurrenceRule?: unknown }).recurrenceRule),
        source: normalizeOptionalString((body as { source?: unknown }).source) ?? "api",
      });
      return sendJson(res, 200, { ok: true, reminder });
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
