"""FastAPI app — webhook endpoint and lifecycle management."""

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from typing import Optional
from fastapi import FastAPI, Request, Response
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from telegram import Update
from app.config import settings
from app.database import init_db
from app.telegram_bot import application
from app.scheduler import scheduler_loop
from app import service

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown logic."""
    # Startup
    logger.info("Initializing database...")
    init_db()

    logger.info("Initializing Telegram bot...")
    await application.initialize()
    await application.start()

    # Set webhook if URL is configured
    if settings.webhook_url:
        webhook_url = f"{settings.webhook_url}/webhook"
        await application.bot.set_webhook(url=webhook_url)
        logger.info(f"Webhook set to {webhook_url}")

    # Start the reminder scheduler as a background task
    logger.info("Starting reminder scheduler...")
    scheduler_task = asyncio.create_task(scheduler_loop(application.bot))

    yield

    # Shutdown
    scheduler_task.cancel()
    await application.stop()
    await application.shutdown()


app = FastAPI(title="Todo Bot", lifespan=lifespan)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/webhook")
async def telegram_webhook(request: Request):
    """Receive Telegram webhook updates."""
    data = await request.json()
    update = Update.de_json(data, application.bot)
    await application.process_update(update)
    return Response(status_code=200)


# --- REST API for frontend ---


class TodoCreate(BaseModel):
    title: str
    description: Optional[str] = None
    due_date: Optional[str] = None
    priority: str = "medium"


class TodoUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    due_date: Optional[str] = None
    priority: Optional[str] = None


class ReminderCreate(BaseModel):
    todo_id: int
    remind_at: str


class IdeaCreate(BaseModel):
    title: str
    description: Optional[str] = None
    category: Optional[str] = None


# Todos
@app.get("/api/todos")
async def api_list_todos(status: Optional[str] = None, priority: Optional[str] = None):
    return json.loads(service.list_todos(status=status, priority=priority))


@app.post("/api/todos")
async def api_add_todo(todo: TodoCreate):
    return json.loads(service.add_todo(**todo.dict(exclude_none=True)))


@app.put("/api/todos/{todo_id}")
async def api_edit_todo(todo_id: int, todo: TodoUpdate):
    return json.loads(service.edit_todo(todo_id=todo_id, **todo.dict(exclude_none=True)))


@app.put("/api/todos/{todo_id}/complete")
async def api_complete_todo(todo_id: int):
    return json.loads(service.complete_todo(todo_id))


@app.delete("/api/todos/{todo_id}")
async def api_delete_todo(todo_id: int):
    return json.loads(service.delete_todo(todo_id))


# Reminders
@app.get("/api/reminders")
async def api_list_reminders(todo_id: Optional[int] = None):
    return json.loads(service.list_reminders(todo_id=todo_id))


@app.post("/api/reminders")
async def api_add_reminder(reminder: ReminderCreate):
    return json.loads(service.add_reminder(**reminder.dict()))


@app.delete("/api/reminders/{reminder_id}")
async def api_cancel_reminder(reminder_id: int):
    return json.loads(service.cancel_reminder(reminder_id))


# Ideas
@app.get("/api/ideas")
async def api_list_ideas(category: Optional[str] = None):
    return json.loads(service.list_ideas(category=category))


@app.post("/api/ideas")
async def api_add_idea(idea: IdeaCreate):
    return json.loads(service.add_idea(**idea.dict(exclude_none=True)))


@app.delete("/api/ideas/{idea_id}")
async def api_delete_idea(idea_id: int):
    return json.loads(service.delete_idea(idea_id))


# Dashboard
@app.get("/", response_class=HTMLResponse)
async def dashboard():
    with open("static/index.html") as f:
        return f.read()
