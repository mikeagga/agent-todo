# Todo/Reminder Bot — Plan

## Context
Build a personal todo/reminder app that can be messaged from a phone (Telegram / iMessage), synced across phone and computer, backed by a Python server hosted on Railway with an SQLite database. An AI agent processes natural language so the user can add tasks, query what's due, mark things complete, etc. conversationally.

## Architecture Overview

```
You (phone or desktop)
        │
        ▼
  Telegram App
        │  (message)
        ▼
  Telegram Bot API
        │  (webhook POST)
        ▼
  Python Server (Railway)
   ├── Telegram Webhook Handler
   │       │
   │       ▼
   ├── AI Agent (OpenAI gpt-4o-mini, function-calling)
   │       │  (decides what action to take)
   │       ▼
   ├── Todo Service (CRUD + queries)
   │       │
   │       ▼
   └── SQLite DB (todos table)
        │
        ▼
  Response sent back through Telegram
```

## Approach

### 1. Python Backend — FastAPI
- FastAPI app as the core server
- Endpoints: Telegram webhook, health check, (optional) REST API for web UI
- Hosted on Railway with a persistent volume for the SQLite DB

### 2. Database — SQLite via SQLAlchemy
- Tables: `todos` (id, title, description, due_date, priority, status, created_at, updated_at, reminder_time)
- Simple, no external DB service needed — Railway persistent volume keeps data

### 3. Telegram Bot
- Use `python-telegram-bot` library
- Webhook mode (not polling) for Railway deployment
- Receives messages → forwards to AI agent → returns response

### 4. AI Agent — OpenAI Function Calling
- Model: `gpt-4o-mini` (cheap, fast, good enough for todo parsing)
- System prompt defines the bot's role as a todo assistant
- Tool/function definitions for: `add_todo`, `list_todos`, `complete_todo`, `delete_todo`, `search_todos`, `get_due_today`, `snooze_todo`
- The AI decides which function to call based on natural language input
- Handles ambiguity, follow-up questions, confirmations

### 5. Cross-Device Sync
- Since the DB is server-side, Telegram on any device sees the same data
- Telegram itself has phone + desktop apps — no extra sync needed

## Files to Create

```
├── app/
│   ├── __init__.py
│   ├── main.py              # FastAPI app, webhook routes
│   ├── config.py            # Settings (env vars, API keys)
│   ├── database.py          # SQLAlchemy setup, models
│   ├── models.py            # Todo SQLAlchemy model
│   ├── service.py           # Todo CRUD operations
│   ├── agent.py             # OpenAI agent with function calling
│   └── telegram_bot.py      # Telegram webhook handler
├── requirements.txt
├── Procfile                  # Railway deployment
├── railway.toml              # Railway config
└── README.md
```

## Reuse
- N/A — greenfield project

## Steps

- [x] **Step 1**: Project scaffolding — `requirements.txt`, `Procfile`, `railway.toml`, config
- [x] **Step 2**: Database layer — SQLAlchemy models, migrations, CRUD service
- [x] **Step 3**: AI Agent — OpenAI function-calling agent with todo tool definitions
- [x] **Step 4**: Telegram bot — webhook handler wired to the AI agent
- [x] **Step 5**: FastAPI app — glue it all together, health check, webhook endpoint
- [x] **Step 6**: Railway deployment config — persistent volume, env vars, README


## Verification
- Run locally: `uvicorn app.main:app --reload`
- Test Telegram webhook with ngrok for local dev
- Send natural language messages and verify:
  - "Remind me to buy groceries tomorrow" → creates todo with due date
  - "What's due today?" → returns list
  - "Mark buy groceries as done" → completes it
- Deploy to Railway and verify webhook works end-to-end

## Decisions Made
- **Single-user** — no auth needed, just you
- **Telegram only** — no iMessage, Telegram covers phone + desktop
- **OpenAI gpt-4o-mini** for AI layer
- **No proactive reminders** for now (can add later)
