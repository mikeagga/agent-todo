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
  <title>Todo/Reminder Dashboard</title>
  <style>
    body { font-family: Inter, system-ui, -apple-system, sans-serif; margin: 0; background: #0b1020; color: #ecf1ff; }
    .wrap { max-width: 1200px; margin: 0 auto; padding: 20px; }
    h1,h2 { margin: 0 0 12px; }
    .panel { background: #141b34; border: 1px solid #2a355f; border-radius: 10px; padding: 14px; margin-bottom: 16px; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; }
    input, select, button { border-radius: 8px; border: 1px solid #41508a; background: #0f1730; color: #ecf1ff; padding: 7px 9px; }
    button { cursor: pointer; }
    button.primary { background: #2f6df6; border-color: #2f6df6; }
    button.warn { background: #b54747; border-color: #b54747; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-bottom: 1px solid #27345f; padding: 8px; vertical-align: top; }
    th { text-align: left; color: #b9c5ef; }
    .status { color: #b9c5ef; font-size: 13px; }
    .small { font-size: 12px; color: #9cadde; }
    .token { width: 320px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Todo / Reminder Dashboard</h1>
    <p class="small">Manual server-side editing UI for todos and reminders.</p>

    <div class="panel">
      <div class="row">
        <label>User</label>
        <input id="userExternalId" value="${DEFAULT_USER_EXTERNAL_ID}" />
        <label>Bearer token</label>
        <input id="token" class="token" placeholder="Only needed if DASHBOARD_TOKEN is set" />
        <button id="reload" class="primary">Reload</button>
      </div>
      <div id="status" class="status">Ready.</div>
    </div>

    <div class="panel">
      <div class="row">
        <h2 style="margin-right:8px;">Todos</h2>
        <label>Status</label>
        <select id="todoStatusFilter">
          <option value="all">all</option>
          <option value="open" selected>open</option>
          <option value="done">done</option>
          <option value="cancelled">cancelled</option>
        </select>
      </div>
      <table>
        <thead>
          <tr><th>ID</th><th>Status</th><th>Title</th><th>Notes</th><th>Priority</th><th>Due</th><th>Actions</th></tr>
        </thead>
        <tbody id="todoRows"></tbody>
      </table>
    </div>

    <div class="panel">
      <div class="row">
        <h2 style="margin-right:8px;">Reminders</h2>
        <label>Status</label>
        <select id="reminderStatusFilter">
          <option value="all">all</option>
          <option value="pending" selected>pending</option>
          <option value="sent">sent</option>
          <option value="cancelled">cancelled</option>
        </select>
      </div>
      <table>
        <thead>
          <tr><th>ID</th><th>Status</th><th>Text</th><th>Time</th><th>Timezone</th><th>Recurrence</th><th>Actions</th></tr>
        </thead>
        <tbody id="reminderRows"></tbody>
      </table>
    </div>
  </div>

  <script>
    const statusEl = document.getElementById('status');
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
      statusEl.style.color = isError ? '#ff9aa2' : '#b9c5ef';
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
        '<td>#' + todo.id + '</td>' +
        '<td>' + todo.status + '</td>' +
        '<td><input data-field="title" value="' + esc(todo.title) + '" /></td>' +
        '<td><input data-field="notes" value="' + esc(todo.notes) + '" /></td>' +
        '<td><select data-field="priority">' + priorityOptions + '</select></td>' +
        '<td><input data-field="dueAt" type="datetime-local" value="' + dueLocal + '" /></td>' +
        '<td><div class="row">' +
        '<button data-action="saveTodo" class="primary">Save</button>' +
        '<button data-action="clearDue">Clear due</button>' +
        '<button data-action="clearNotes">Clear notes</button>' +
        '<button data-action="completeTodo">Complete</button>' +
        '<button data-action="cancelTodo" class="warn">Cancel</button>' +
        '</div></td>' +
        '</tr>';
    }

    function reminderRow(reminder) {
      const remindLocal = toLocalInputValue(reminder.remindAt);
      return '<tr data-id="' + reminder.id + '">' +
        '<td>#' + reminder.id + '</td>' +
        '<td>' + reminder.status + '</td>' +
        '<td><input data-field="text" value="' + esc(reminder.text) + '" /></td>' +
        '<td><input data-field="remindAt" type="datetime-local" value="' + remindLocal + '" /></td>' +
        '<td><input data-field="timezone" value="' + esc(reminder.timezone) + '" /></td>' +
        '<td><input data-field="recurrenceRule" value="' + esc(reminder.recurrenceRule) + '" /></td>' +
        '<td><div class="row">' +
        '<button data-action="saveReminder" class="primary">Save</button>' +
        '<button data-action="clearRecurrence">Clear recurrence</button>' +
        '<button data-action="cancelReminder" class="warn">Cancel</button>' +
        '</div></td>' +
        '</tr>';
    }

    async function loadTodos() {
      const status = document.getElementById('todoStatusFilter').value;
      const qs = new URLSearchParams({ userExternalId: userId(), limit: '200' });
      if (status !== 'all') qs.set('status', status);
      const data = await api('/api/todos?' + qs.toString(), { method: 'GET', headers: {} });
      todoRowsEl.innerHTML = data.todos.map(todoRow).join('') || '<tr><td colspan="7">No todos</td></tr>';
    }

    async function loadReminders() {
      const status = document.getElementById('reminderStatusFilter').value;
      const qs = new URLSearchParams({ userExternalId: userId(), limit: '200' });
      if (status !== 'all') qs.set('status', status);
      const data = await api('/api/reminders?' + qs.toString(), { method: 'GET', headers: {} });
      reminderRowsEl.innerHTML = data.reminders.map(reminderRow).join('') || '<tr><td colspan="7">No reminders</td></tr>';
    }

    async function reloadAll() {
      setStatus('Loading...');
      try {
        await Promise.all([loadTodos(), loadReminders()]);
        setStatus('Loaded.');
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
          setStatus('Todo #' + id + ' updated.');
        } else if (btn.dataset.action === 'clearDue') {
          await api('/api/todos/' + id, { method: 'PATCH', body: JSON.stringify({ userExternalId: userId(), clearDueAt: true }) });
          setStatus('Todo #' + id + ' due date cleared.');
        } else if (btn.dataset.action === 'clearNotes') {
          await api('/api/todos/' + id, { method: 'PATCH', body: JSON.stringify({ userExternalId: userId(), clearNotes: true }) });
          setStatus('Todo #' + id + ' notes cleared.');
        } else if (btn.dataset.action === 'completeTodo') {
          await api('/api/todos/' + id + '/complete', { method: 'POST', body: JSON.stringify({ userExternalId: userId() }) });
          setStatus('Todo #' + id + ' completed.');
        } else if (btn.dataset.action === 'cancelTodo') {
          await api('/api/todos/' + id + '/cancel', { method: 'POST', body: JSON.stringify({ userExternalId: userId() }) });
          setStatus('Todo #' + id + ' cancelled.');
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
          setStatus('Reminder #' + id + ' updated.');
        } else if (btn.dataset.action === 'clearRecurrence') {
          await api('/api/reminders/' + id, { method: 'PATCH', body: JSON.stringify({ userExternalId: userId(), clearRecurrenceRule: true }) });
          setStatus('Reminder #' + id + ' recurrence cleared.');
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
