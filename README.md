# agent-todo backbone (local first)

Local-first todo/reminder backend with:

- SQLite schema + migrations
- strongly typed protocol contracts
- service layer for todo/reminder/memory primitives
- project-local pi extension (`.pi/extensions/todo-reminders`)
- Telegram relay bot (`src/telegram/bot.ts`)
- built-in web dashboard/API (`src/web/dashboard-server.ts`)

---

## 1) Quick start (local)

```bash
npm install
npm run db:init
npm run demo
```

Useful commands:

```bash
npm run telegram:bot   # Telegram relay + reminder dispatcher + optional auto schedules
npm run dashboard      # web dashboard + internal JSON API
npm run typecheck
```

Default DB file:

- `data/todo-reminders.db`

Override DB path:

```bash
DB_PATH=/absolute/path/my.db npm run db:init
```

---

## 2) Runtime features

### Telegram relay bot

- Forwards your Telegram text to `pi --mode rpc`
- Sends assistant response back to Telegram
- Optional reminder dispatcher pushes due reminders directly (without LLM)

### Reminder dispatcher

- Polls due reminders on interval
- Retry/backoff on Telegram send failures
- Dispatch claim/receipt tracking
- Handles recurring reminders after send

Supported recurrence fields in `recurrenceRule`:

- `FREQ=MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY` (required)
- `INTERVAL` (optional)
- `COUNT` (optional)
- `UNTIL` (optional)

### Auto PI schedules

Configured via file (not env vars):

- `.pi/auto-pi-schedules.json`

Allows scheduled prompts (e.g. morning agenda / end-of-day closeout) to run and send output to Telegram.

### Web dashboard

- View/filter todos and reminders
- Manually edit todo/reminder fields
- Complete/cancel todos and cancel reminders
- Internal JSON endpoints under `/api/*`

---

## 3) Configuration

Set env vars in `.env` or your hosting platform.

### Core

- `DB_PATH` (recommended explicit in production)
- `TODO_USER_ID` (default `local-user`)
- `DEFAULT_TIMEZONE` (default `UTC`)

### Telegram bot

- `TELEGRAM_BOT_TOKEN` (**required**)
- `TELEGRAM_ALLOWED_CHAT_ID` (recommended)
- `TELEGRAM_MODE` (`polling` default, or `webhook`)
- `TELEGRAM_REMINDER_CHAT_ID` (optional; falls back to allowed chat)

Webhook mode only:

- `TELEGRAM_WEBHOOK_URL`
- `TELEGRAM_WEBHOOK_PATH` (default `/telegram/webhook`)
- `TELEGRAM_WEBHOOK_SECRET` (recommended)
- `TELEGRAM_WEBHOOK_HOST` / `TELEGRAM_WEBHOOK_PORT`

### PI relay process

- `PI_BIN` (default `pi`)
- `PI_PROVIDER` / `PI_MODEL` (optional)
- `PI_EXTRA_ARGS` (optional)

### Reminder dispatcher tuning

- `REMINDER_NOTIFICATIONS_ENABLED` (`true` default)
- `REMINDER_POLL_SECONDS` (`30` default)
- `REMINDER_DISPATCH_STALE_SECONDS` (`120` default)
- `REMINDER_SEND_MAX_RETRIES` (`3` default)
- `REMINDER_SEND_RETRY_BASE_MS` (`1000` default)

### Dashboard

- `DASHBOARD_HOST` (default `0.0.0.0`)
- `DASHBOARD_PORT` (default `8787`, falls back to platform `PORT`)
- `DASHBOARD_TOKEN` (recommended in production)

Auth behavior:

- `GET /` dashboard page loads without auth
- `/api/*` requires `Authorization: Bearer <DASHBOARD_TOKEN>` when token is set
- You can open once with `?token=<DASHBOARD_TOKEN>` to auto-fill/store token in UI

---

## 4) Auto PI schedules file

Path:

- `.pi/auto-pi-schedules.json`

Example:

```json
{
  "enabled": true,
  "pollSeconds": 30,
  "defaultTimezone": "America/New_York",
  "defaultChatId": "8793068235",
  "schedules": [
    {
      "id": "morning-agenda",
      "time": "08:00",
      "prompt": "Give me a concise morning agenda for today."
    },
    {
      "id": "end-of-day-closeout",
      "time": "18:00",
      "prompt": "Give me an end-of-day closeout checklist."
    }
  ]
}
```

---

## 5) Extension tools available

From `.pi/extensions/todo-reminders/index.ts`:

- `resolve_time_expression`
- `add_todo`
- `update_todo`
- `list_todos`
- `list_todos_by_day`
- `search_todos`
- `complete_todo`
- `cancel_todo`
- `add_reminder`
- `update_reminder`
- `add_todo_reminder`
- `list_due_reminders`
- `list_reminders`
- `list_reminders_by_day`
- `cancel_reminder`

Command:

- `/todo-db-health`

---

## 6) Data model and services

### Database migrations

- `src/db/migrations/001_init.sql`
- `src/db/migrations/002_link_reminders_todos.sql`
- `src/db/migrations/003_conversation_memory.sql`
- `src/db/migrations/004_reminder_dispatch_receipts.sql`

### Services

- `TodoService`: add/update/complete/cancel/list/search/get
- `ReminderService`: add/update/list/send/cancel + recurrence + dispatch receipts
- `MemoryService`: user settings/memory + sessions + pending confirmations

Entry point:

- `createBackbone()` in `src/index.ts`

---

## 7) Local dashboard usage

Run:

```bash
npm run dashboard
```

Open:

- `http://127.0.0.1:8787/`
- `http://127.0.0.1:8787/health`

If `DASHBOARD_TOKEN` is set, paste it in the dashboard header token field.

---

## 8) Railway deployment

Current Docker startup runs both in one container:

- `telegram:bot` (background)
- `dashboard` (foreground web process)

Recommended Railway setup:

- Mount a volume at `/data`
- Set `DB_PATH=/data/todo-reminders.db`
- Set `DASHBOARD_HOST=0.0.0.0`
- Set `DASHBOARD_TOKEN=<strong-random-token>`
- Usually use `TELEGRAM_MODE=polling`

---

## 9) Long-term memory / behavior configuration

There are two practical “long-term memory” layers right now:

1. **Behavior/instructions memory** (recommended)
   - Put persistent response preferences in:
     - project: `.pi/AGENTS.md`
     - global: `~/.pi/agent/AGENTS.md`
   - Example: response style, verbosity, decision rules, coding conventions.

2. **Scheduled behavior memory**
   - Put recurring assistant routines in:
     - `.pi/auto-pi-schedules.json`

Note: database `user_memory` exists (via `MemoryService`) but there is no user-facing tool yet to edit it directly from chat/dashboard. If you want, next step is adding explicit tools/UI for memory CRUD (`remember`, `recall`, `forget`).

---

## 10) Future HTTP contract

- `src/protocol/openapi.yaml` (spec for a future public API)
- Current dashboard already exposes internal `/api/*` endpoints for UI operations
