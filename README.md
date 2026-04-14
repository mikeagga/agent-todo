# Todo Bot 🤖

A personal todo/reminder bot you message via Telegram. An AI agent (GPT-4o-mini) interprets your natural language and manages your tasks in a SQLite database.

## How It Works

```
You (Telegram) → Webhook → FastAPI Server → AI Agent → SQLite DB → Response back to Telegram
```

## Setup

### 1. Create a Telegram Bot
1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token

### 2. Get an OpenAI API Key
1. Go to [platform.openai.com](https://platform.openai.com)
2. Create an API key

### 3. Local Development
```bash
# Clone and install
pip install -r requirements.txt

# Configure
cp .env.example .env
# Edit .env with your tokens

# Run
uvicorn app.main:app --reload

# In another terminal, use ngrok for webhook testing:
ngrok http 8000
# Then set WEBHOOK_URL=https://your-ngrok-url.ngrok.io in .env and restart
```

### 4. Deploy to Railway
1. Push to GitHub
2. Create a new Railway project from the repo
3. Add a **Volume** mounted at `/app/data` (for SQLite persistence)
4. Set environment variables:
   - `TELEGRAM_BOT_TOKEN` — from BotFather
   - `OPENAI_API_KEY` — from OpenAI
   - `WEBHOOK_URL` — your Railway app URL (e.g. `https://todo-bot-production.up.railway.app`)
   - `DATABASE_URL` — `sqlite:////app/data/todos.db` (note: 4 slashes for absolute path)
5. Deploy!

## Usage Examples

Just message your bot naturally:

- "Remind me to buy groceries tomorrow"
- "Add a high priority task: finish report by Friday"
- "What's due this week?"
- "Show all my todos"
- "Mark the groceries task as done"
- "Snooze the report to next Monday"
- "Delete the groceries task"
- "Search for anything about meeting"

## Tech Stack
- **FastAPI** — web server
- **python-telegram-bot** — Telegram integration
- **OpenAI GPT-4o-mini** — natural language understanding
- **SQLAlchemy + SQLite** — database
- **Railway** — hosting
