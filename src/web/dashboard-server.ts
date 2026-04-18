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
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>☆彡 Agent Todo Dashboard 彡☆</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Comic Sans MS', 'Marker Felt', 'Trebuchet MS', cursive, sans-serif;
      background: #ffb3d9 url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="%23ffcce6" width="50" height="50"/><rect fill="%23ffe6f2" x="50" width="50" height="50"/><rect fill="%23ffe6f2" y="50" width="50" height="50"/><rect fill="%23ffcce6" x="50" y="50" width="50" height="50"/></svg>');
      color: #4a0066;
      padding: 20px;
      min-height: 100vh;
    }
    .ascii-banner {
      background: linear-gradient(45deg, #ff6bda, #6bc0ff);
      color: white;
      padding: 20px;
      border: 4px dashed #ff1493;
      border-radius: 15px;
      margin-bottom: 20px;
      box-shadow: 0 8px 16px rgba(255, 20, 147, 0.3);
      text-align: center;
      font-family: monospace;
      white-space: pre;
      line-height: 1.2;
      font-size: 11px;
      text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
    }
    h1 {
      font-size: 32px;
      margin-bottom: 8px;
      color: #ff1493;
      text-shadow: 3px 3px 0 #ffb3d9, 6px 6px 0 #ffd9ec;
      text-align: center;
      animation: rainbow 3s ease-in-out infinite;
    }
    @keyframes rainbow {
      0%, 100% { color: #ff1493; }
      25% { color: #ff6bda; }
      50% { color: #6bc0ff; }
      75% { color: #9d6bff; }
    }
    h2 {
      font-size: 20px;
      margin: 20px 0 12px 0;
      color: #ff1493;
      border-bottom: 3px dotted #ffb3d9;
      padding-bottom: 6px;
      background: linear-gradient(90deg, #ffe6f2, transparent);
      padding: 10px;
      border-radius: 8px 8px 0 0;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
      background: rgba(255, 255, 255, 0.95);
      border: 5px solid #ff6bda;
      border-radius: 20px;
      padding: 25px;
      box-shadow: 0 10px 30px rgba(255, 20, 147, 0.4);
    }
    .row {
      display: flex;
      gap: 12px;
      margin-bottom: 16px;
      flex-wrap: nowrap;
    }
    .status-bar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 16px;
      background: linear-gradient(135deg, #ffffcc 0%, #fff9b3 100%);
      border: 3px solid #ffcc00;
      border-radius: 15px;
      font-size: 14px;
      margin-bottom: 20px;
      box-shadow: 0 4px 8px rgba(255, 204, 0, 0.3);
      font-weight: bold;
    }
    .status-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #00ff00;
      box-shadow: 0 0 10px #00ff00;
      animation: blink 1s ease-in-out infinite;
    }
    .status-dot.error { background: #ff0066; box-shadow: 0 0 10px #ff0066; }
    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
    .table-scroll {
      overflow-x: auto;
      background: #ffffff;
      border: 4px solid #6bc0ff;
      border-radius: 12px;
      padding: 12px;
      margin-bottom: 20px;
      box-shadow: inset 0 0 10px rgba(107, 192, 255, 0.2);
    }
    table {
      width: 100%\n      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      padding: 10px 12px;
      text-align: left;
      border-bottom: 2px dotted #ffb3d9;
    }
    th {
      font-weight: bold;
      color: #ff1493;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
      background: linear-gradient(180deg, #ffe6f2 0%, #ffcce6 100%);
      border: 2px solid #ff6bda;
    }
    tr:nth-child(even) { background: #fffef0; }
    tr:hover { background: #fff9e6 !important; }
    input, select, button {
      font-family: inherit;
      font-size: 13px;
      padding: 8px 12px;
      border-radius: 8px;
      border: 2px solid #ff6bda;
      background: #ffffff;
      color: #4a0066;
    }
    input:focus, select:focus {
      outline: none;
      border-color: #6bc0ff;
      box-shadow: 0 0 8px rgba(107, 192, 255, 0.5);
    }
    button {
      cursor: pointer;
      background: linear-gradient(135deg, #6bc0ff 0%, #9d6bff 100%);
      border: 2px solid #4a9fff;
      color: #fff;
      font-weight: bold;
      transition: all 0.2s ease;
      white-space: nowrap;
      box-shadow: 0 4px 6px rgba(107, 192, 255, 0.3);
    }
    button:hover { 
      background: linear-gradient(135deg, #9d6bff 0%, #ff6bda 100%);
      transform: translateY(-2px);
      box-shadow: 0 6px 12px rgba(255, 107, 218, 0.4);
    }
    button:active { transform: translateY(0); }
    button.danger { 
      background: linear-gradient(135deg, #ff6b6b 0%, #ff1493 100%);
      border-color: #ff1493;
    }
    button.danger:hover { 
      background: linear-gradient(135deg, #ff1493 0%, #ff0066 100%);
    }
    button.small {
      font-size: 11px;
      padding: 6px 10px;
    }
    label {
      display: block;
      font-size: 11px;
      font-weight: bold;
      color: #ff1493;
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .field {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .field.grow { flex: 1; }
    .field.auto { flex: 0 0 auto; }
    .priority-urgent { color: #ff0066 !important; font-weight: bold; }
    .priority-high { color: #ff6b00 !important; font-weight: bold; }
    .priority-normal { color: #4a0066; }
    .priority-low { color: #9d6bff; }
    code {
      background: #ffffcc;
      padding: 3px 8px;
      border-radius: 5px;
      font-size: 11px;
      font-family: 'Courier New', monospace;
      border: 1px dashed #ffcc00;
    }
    td.row {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      flex-wrap: nowrap;
    }
    td .field-label {
      font-size: 11px;
      font-weight: bold;
      color: #ff1493;
      min-width: 72px;
      flex-shrink: 0;
      padding-top: 5px;
    }
    td input, td select { flex: 1; min-width: 0; }
    td .row {
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 0;
    }
    .footer {
      text-align: center;
      margin-top: 30px;
      padding: 20px;
      background: linear-gradient(135deg, #ffe6f2 0%, #e6f2ff 100%);
      border: 3px dotted #ff6bda;
      border-radius: 15px;
      font-size: 12px;
      color: #4a0066;
    }
    .footer a {
      color: #6bc0ff;
      text-decoration: none;
      font-weight: bold;
    }
    .footer a:hover {
      color: #ff1493;
      text-decoration: underline wavy;
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
                                                                                    
           ~ Your friendly neighborhood task manager ~
    </div>
    <h1>☆ Agent Todo Dashboard ☆</h1>

    <div id="status" class="status-bar">
      <div class="status-dot"></div>
      <span id="statusText">☆ Ready to manage your tasks! ☆</span>
    </div>

    <div class="row">
      <div class="field auto">
        <label>User ID</label>
        <input id="userId" type="text" value="demo-user" />
      </div>
      <div class="field auto" style="justify-content: flex-end;">
        <label>&nbsp;</label>
        <button id="reload">Reload All</button>
      </div>
    </div>

    <h2>✿ Your Todos ✿</h2>
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

    <h2>✿ Your Reminders ✿</h2>
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

    <div class="footer">
      <p>☆ Made with love for organizing your life! ☆</p>
      <p style="margin-top: 10px; font-size: 10px;">Powered by Agent Todo | <a href="https://github.com" target="_blank">Visit us!</a></p>
    </div>
  </div>

<script>
  const statusEl = document.getElementById('statusText');
  const statusDotEl = document.querySelector('.status-dot');
  const userIdInput = document.getElementById('userId');

  function userId() { return userIdInput.value || 'demo-user'; }

  function setStatus(msg, isError = false) {
    statusEl.textContent = msg;
    statusEl.style.color = isError ? '#ff0066' : '#4a0066';
    statusDotEl.className = 'status-dot' + (isError ? ' error' : '');
  }

  async function api(path, options = {}) {
    const headers = { ...options.headers };
    if (options.body) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, { ...options, headers });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || ('HTTP ' + res.status));
    }
    return res.json();
  }

  async function loadTodos() {
    const filter = document.getElementById('todoStatusFilter').value;
    const params = new URLSearchParams({ userExternalId: userId() });
    if (filter !== 'all') params.set('status', filter);
    const todos = await api('/api/todos?' + params);
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
    const reminders = await api('/api/reminders?' + params);
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
      setStatus('☆ Ready to manage your tasks! ☆');
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
