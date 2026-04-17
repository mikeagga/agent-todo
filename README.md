# agent-todo backbone (local first)

This repo contains the local-first backbone + a project-local pi extension + Telegram relay for your personal todo/reminder project:

- SQLite schema + migrations
- strongly typed protocol contracts
- service layer for todo/reminder/memory primitives
- project-local pi extension (`.pi/extensions/todo-reminders`)
- Telegram relay bot (`src/telegram/bot.ts`)
- no HTTP server yet

## Stack

- TypeScript + Node.js
- SQLite via `better-sqlite3`
- Zod for protocol validation

## Quick start

```bash
npm install
npm run db:init
npm run demo
```

## Telegram integration (relay mode: polling or webhook)

Set env vars (in `.env` or shell):

- `TELEGRAM_BOT_TOKEN` (required)
- `TELEGRAM_ALLOWED_CHAT_ID` (recommended; restricts bot to your chat)
- `TELEGRAM_MODE` (`polling` default, or `webhook`)
- `PI_PROVIDER` / `PI_MODEL` (optional; choose provider/model for rpc process)
- `PI_BIN` (optional; default `pi`)
- `PI_EXTRA_ARGS` (optional; additional args for `pi --mode rpc`)
- `REMINDER_NOTIFICATIONS_ENABLED` (`true` default; set `false` to disable server push reminders)
- `REMINDER_POLL_SECONDS` (`30` default)
- `REMINDER_DISPATCH_STALE_SECONDS` (`120` default; retry claim window for stuck dispatches)
- `REMINDER_SEND_MAX_RETRIES` (`3` default)
- `REMINDER_SEND_RETRY_BASE_MS` (`1000` default; exponential backoff base)
- `TELEGRAM_REMINDER_CHAT_ID` (optional target chat for reminder pushes; falls back to `TELEGRAM_ALLOWED_CHAT_ID`)
- `TODO_USER_ID` (optional; defaults to `local-user` for reminder polling)

For webhook mode also set:
- `TELEGRAM_WEBHOOK_URL` (public HTTPS URL Telegram should call)
- `TELEGRAM_WEBHOOK_PATH` (default `/telegram/webhook`)
- `TELEGRAM_WEBHOOK_SECRET` (optional but recommended)
- `TELEGRAM_WEBHOOK_HOST` / `TELEGRAM_WEBHOOK_PORT` (local listener, defaults `0.0.0.0:8788`)

Run:

```bash
npm run telegram:bot
```

Behavior:
- Telegram bot forwards your exact message text to `pi --mode rpc`
- It waits for the agent response and sends the assistant text back to Telegram
- Reminder dispatcher runs server-side on an interval and pushes due reminders directly to Telegram
- Reminder push uses DB queries only (`listDueReminders` + dispatch claim/receipt tracking + `markReminderSent`) and does not call the LLM
- Reminder delivery includes retry/backoff and late-reminder labeling
- User-facing date/time display is formatted in 12-hour time (e.g. `Apr 17, 2026 9:30 PM`)
- No local intent parsing happens in the Telegram layer

Default DB file:

- `data/todo-reminders.db`

You can override with:

```bash
DB_PATH=/absolute/path/my.db npm run db:init
```

## What was added

### Database

- `src/db/migrations/001_init.sql`
  - `users`
  - `todos`
  - `reminders`
  - `schema_migrations`
- `src/db/migrations/002_link_reminders_todos.sql`
  - links reminders to todos via `todo_id`
- `src/db/migrations/003_conversation_memory.sql`
  - `user_settings` (timezone/defaults/preferences)
  - `user_memory` (long-term facts/preferences)
  - `conversation_sessions` (short-term session lifecycle)
  - `pending_actions` (confirmation/clarification tokens + TTL)

### Protocol contracts (tool/API-friendly)

- `src/protocol/contracts.ts`
  - `add_todo`
  - `add_reminder` (supports optional `todoId` link)
  - `complete_todo`
  - `cancel_todo`
  - `list_todos`
  - `search_todos`
  - `list_due_reminders`
  - `list_reminders`
  - `cancel_reminder`
- Extension-only tool contract addition in `.pi/extensions/todo-reminders/index.ts`
  - `add_todo_reminder`

### Future HTTP contract (spec only)

- `src/protocol/openapi.yaml`

### Services

- `TodoService`
  - addTodo
  - completeTodo
  - cancelTodo
  - listTodos
  - searchTodos
  - getTodoById
- `ReminderService`
  - addReminder
  - listDueReminders
  - listReminders
  - markReminderSent
  - cancelReminder
- `MemoryService`
  - user settings/memory upsert + reads
  - conversation session open/touch/close with idle rollover support
  - pending action token lifecycle (create/read/update/expire)

### Entry point

- `createBackbone()` in `src/index.ts`

## Pi extension (started)

I added a project-local pi extension at:

- `.pi/extensions/todo-reminders/index.ts`

It registers tools:

- `resolve_time_expression` (NL date/time -> ISO UTC)
- `add_todo`
- `list_todos`
- `search_todos` (better for older/history lookup)
- `complete_todo`
- `cancel_todo`
- `add_reminder` (optional `todoId` linkage)
- `add_todo_reminder` (link reminder directly to a todo, including offset-before-due)
- `list_due_reminders`
- `list_reminders` (list all reminders with filters)
- `cancel_reminder`

and a command:

- `/todo-db-health`

### Use it in pi

From this project directory:

1. Ensure DB is initialized: `npm run db:init`
2. Start pi in this repo (project-local extensions auto-load)
3. Run `/reload` if pi was already open
4. Test with prompts like:
   - `add a todo to buy eggs tomorrow at 9am`
   - `show my open todos`
   - `remind me in 30 minutes to stretch`

Behavior safeguards:

- Destructive actions (`complete_todo`, `cancel_todo`, `cancel_reminder`) are channel-friendly:
  - they return `responseType: "confirmation_required"` unless `confirmed: true` is passed
  - responses include `confirmationToken` + `expiresAt` for server-side confirmation tracking
  - this works in Telegram without CLI/TUI confirmation dialogs
- Conversation/session lifecycle is automatic:
  - every input touch checks/rolls over active session by idle timeout
  - pending actions are auto-expired on each new input
  - defaults: `SESSION_IDLE_MINUTES=60`, `PENDING_ACTION_TTL_MINUTES=15`
- Date fields are validated as ISO date-time.
- Natural-language time can be resolved using `resolve_time_expression` (powered by chrono-node + timezone handling).
- `add_todo` / `add_reminder` can auto-resolve `timeExpression` when `dueAt`/`remindAt` is not provided.
- Linked reminders (`todoId`) are automatically cancelled when the todo is completed or cancelled.
- If a time is ambiguous, tools return a structured clarification payload:
  - `details.responseType = "clarification"`
  - `details.needsClarification = true`
  - `details.question = "..."`
  This is easier for Telegram relays to forward as a direct follow-up question.

Defaults:

- `userExternalId` defaults to env `TODO_USER_ID` or `local-user`
- DB path defaults to `data/todo-reminders.db` (override with `DB_PATH`)

## Next recommended step

When you want, I can add a minimal local HTTP API (`/v1/todos`, `/v1/reminders`) on top of this backbone so your future pi extension and Telegram bot both use the same interface.
