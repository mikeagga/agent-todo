"""Todo CRUD service — called by the AI agent's tool functions."""

import asyncio
import json
from datetime import date, datetime, timedelta
from typing import Optional
from zoneinfo import ZoneInfo
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.database import SessionLocal
from app.models import Todo, Reminder, Idea
from app import change_log as change_log_service

EASTERN = ZoneInfo("America/New_York")

# Wake event — set this to wake the scheduler whenever reminders change
scheduler_wake_event = asyncio.Event()


def _now_eastern() -> datetime:
    """Get current datetime in US Eastern time."""
    return datetime.now(EASTERN)


def _today_eastern() -> date:
    """Get today's date in US Eastern time."""
    return _now_eastern().date()


def _get_db() -> Session:
    return SessionLocal()


def add_todo(
    title: str,
    description: Optional[str] = None,
    due_date: Optional[str] = None,
    priority: str = "medium",
) -> str:
    """Add a new todo. due_date should be ISO format (YYYY-MM-DD)."""
    db = _get_db()
    try:
        todo = Todo(
            title=title,
            description=description,
            due_date=date.fromisoformat(due_date) if due_date else None,
            priority=priority,
        )
        db.add(todo)
        db.commit()
        db.refresh(todo)
        return json.dumps({"success": True, "todo": todo.to_dict()})
    finally:
        db.close()


def list_todos(
    status: Optional[str] = None,
    due_before: Optional[str] = None,
    due_after: Optional[str] = None,
    priority: Optional[str] = None,
) -> str:
    """List todos with optional filters."""
    db = _get_db()
    try:
        query = select(Todo)
        if status:
            query = query.where(Todo.status == status)
        if due_before:
            query = query.where(Todo.due_date <= date.fromisoformat(due_before))
        if due_after:
            query = query.where(Todo.due_date >= date.fromisoformat(due_after))
        if priority:
            query = query.where(Todo.priority == priority)
        query = query.order_by(Todo.due_date.asc().nullslast(), Todo.created_at.desc())
        todos = db.scalars(query).all()
        return json.dumps({"todos": [t.to_dict() for t in todos], "count": len(todos)})
    finally:
        db.close()


def complete_todo(todo_id: int) -> str:
    """Mark a todo as done and cancel its pending reminders."""
    db = _get_db()
    try:
        todo = db.get(Todo, todo_id)
        if not todo:
            return json.dumps({"success": False, "error": f"Todo #{todo_id} not found"})
        todo.status = "done"
        # Cancel all unsent reminders for this todo
        db.execute(
            select(Reminder)
            .where(Reminder.todo_id == todo_id, Reminder.sent == False)
        )
        for r in db.scalars(select(Reminder).where(Reminder.todo_id == todo_id, Reminder.sent == False)):
            r.sent = True
        db.commit()
        db.refresh(todo)
        scheduler_wake_event.set()
        return json.dumps({"success": True, "todo": todo.to_dict()})
    finally:
        db.close()


def delete_todo(todo_id: int) -> str:
    """Delete a todo permanently (CASCADE deletes its reminders)."""
    db = _get_db()
    try:
        todo = db.get(Todo, todo_id)
        if not todo:
            return json.dumps({"success": False, "error": f"Todo #{todo_id} not found"})
        title = todo.title
        db.delete(todo)
        db.commit()
        scheduler_wake_event.set()
        return json.dumps({"success": True, "deleted": title})
    finally:
        db.close()


def search_todos(query: str) -> str:
    """Search todos by title/description (case-insensitive)."""
    db = _get_db()
    try:
        results = db.scalars(
            select(Todo).where(
                (Todo.title.ilike(f"%{query}%"))
                | (Todo.description.ilike(f"%{query}%"))
            )
        ).all()
        return json.dumps({"todos": [t.to_dict() for t in results], "count": len(results)})
    finally:
        db.close()


def get_current_datetime() -> str:
    """Get the current date and time in US Eastern time."""
    now = _now_eastern()
    return json.dumps({
        "date": now.date().isoformat(),
        "time": now.strftime("%I:%M %p"),
        "day_of_week": now.strftime("%A"),
        "timezone": "US/Eastern",
        "iso": now.isoformat(),
    })


def get_due_today() -> str:
    """Get all todos due today."""
    today = _today_eastern().isoformat()
    return list_todos(status="pending", due_before=today, due_after=today)


def get_due_this_week() -> str:
    """Get all pending todos due this week."""
    today = _today_eastern()
    end_of_week = today + timedelta(days=(6 - today.weekday()))
    return list_todos(
        status="pending",
        due_after=today.isoformat(),
        due_before=end_of_week.isoformat(),
    )


def snooze_todo(todo_id: int, new_due_date: str) -> str:
    """Reschedule a todo to a new date."""
    db = _get_db()
    try:
        todo = db.get(Todo, todo_id)
        if not todo:
            return json.dumps({"success": False, "error": f"Todo #{todo_id} not found"})
        todo.due_date = date.fromisoformat(new_due_date)
        db.commit()
        db.refresh(todo)
        return json.dumps({"success": True, "todo": todo.to_dict()})
    finally:
        db.close()


def edit_todo(
    todo_id: int,
    title: Optional[str] = None,
    description: Optional[str] = None,
    due_date: Optional[str] = None,
    priority: Optional[str] = None,
) -> str:
    """Edit an existing todo's fields."""
    db = _get_db()
    try:
        todo = db.get(Todo, todo_id)
        if not todo:
            return json.dumps({"success": False, "error": f"Todo #{todo_id} not found"})
        if title is not None:
            todo.title = title
        if description is not None:
            todo.description = description
        if due_date is not None:
            todo.due_date = date.fromisoformat(due_date)
        if priority is not None:
            todo.priority = priority
        db.commit()
        db.refresh(todo)
        return json.dumps({"success": True, "todo": todo.to_dict()})
    finally:
        db.close()


# --- Reminder functions ---


def add_reminder(todo_id: int, remind_at: str) -> str:
    """Add a reminder for a todo. remind_at should be ISO format (YYYY-MM-DDTHH:MM)."""
    db = _get_db()
    try:
        todo = db.get(Todo, todo_id)
        if not todo:
            return json.dumps({"success": False, "error": f"Todo #{todo_id} not found"})
        remind_dt = datetime.fromisoformat(remind_at).replace(tzinfo=EASTERN)
        reminder = Reminder(todo_id=todo_id, remind_at=remind_dt)
        db.add(reminder)
        db.commit()
        db.refresh(reminder)
        scheduler_wake_event.set()
        return json.dumps({"success": True, "reminder": reminder.to_dict(), "todo_title": todo.title})
    finally:
        db.close()


def list_reminders(todo_id: Optional[int] = None) -> str:
    """List upcoming unsent reminders, optionally filtered by todo."""
    db = _get_db()
    try:
        query = select(Reminder).where(Reminder.sent == False)
        if todo_id:
            query = query.where(Reminder.todo_id == todo_id)
        query = query.order_by(Reminder.remind_at.asc())
        reminders = db.scalars(query).all()
        results = []
        for r in reminders:
            todo = db.get(Todo, r.todo_id)
            results.append({
                **r.to_dict(),
                "todo_title": todo.title if todo else "Unknown",
            })
        return json.dumps({"reminders": results, "count": len(results)})
    finally:
        db.close()


def cancel_reminder(reminder_id: int) -> str:
    """Cancel/delete a reminder."""
    db = _get_db()
    try:
        reminder = db.get(Reminder, reminder_id)
        if not reminder:
            return json.dumps({"success": False, "error": f"Reminder #{reminder_id} not found"})
        db.delete(reminder)
        db.commit()
        scheduler_wake_event.set()
        return json.dumps({"success": True, "deleted_reminder_id": reminder_id})
    finally:
        db.close()


def get_next_pending_reminder() -> Optional[Reminder]:
    """Get the next unsent reminder (used by scheduler). Returns ORM object or None."""
    db = _get_db()
    try:
        reminder = db.scalars(
            select(Reminder)
            .where(Reminder.sent == False)
            .order_by(Reminder.remind_at.asc())
            .limit(1)
        ).first()
        if reminder:
            _ = reminder.todo_id, reminder.remind_at, reminder.id
        return reminder
    finally:
        db.close()


def get_reminder_with_todo(reminder_id: int) -> Optional[dict]:
    """Get a reminder and its linked todo details (used by scheduler for message formatting)."""
    db = _get_db()
    try:
        reminder = db.get(Reminder, reminder_id)
        if not reminder:
            return None
        todo = db.get(Todo, reminder.todo_id)
        return {
            "reminder_id": reminder.id,
            "remind_at": reminder.remind_at,
            "todo_title": todo.title if todo else "Unknown",
            "todo_description": todo.description if todo else None,
            "todo_due_date": todo.due_date.isoformat() if todo and todo.due_date else None,
            "todo_priority": todo.priority if todo else None,
        }
    finally:
        db.close()


def mark_reminder_sent(reminder_id: int) -> None:
    """Mark a reminder as sent (used by scheduler)."""
    db = _get_db()
    try:
        reminder = db.get(Reminder, reminder_id)
        if reminder:
            reminder.sent = True
            db.commit()
    finally:
        db.close()


# --- Idea functions ---


def add_idea(title: str, description: Optional[str] = None, category: Optional[str] = None) -> str:
    """Jot down an idea."""
    db = _get_db()
    try:
        idea = Idea(title=title, description=description, category=category)
        db.add(idea)
        db.commit()
        db.refresh(idea)
        return json.dumps({"success": True, "idea": idea.to_dict()})
    finally:
        db.close()


def list_ideas(category: Optional[str] = None) -> str:
    """List all ideas, optionally filtered by category."""
    db = _get_db()
    try:
        query = select(Idea)
        if category:
            query = query.where(Idea.category.ilike(f"%{category}%"))
        query = query.order_by(Idea.created_at.desc())
        ideas = db.scalars(query).all()
        return json.dumps({"ideas": [i.to_dict() for i in ideas], "count": len(ideas)})
    finally:
        db.close()


def search_ideas(query: str) -> str:
    """Search ideas by keyword."""
    db = _get_db()
    try:
        results = db.scalars(
            select(Idea).where(
                (Idea.title.ilike(f"%{query}%"))
                | (Idea.description.ilike(f"%{query}%"))
            )
        ).all()
        return json.dumps({"ideas": [i.to_dict() for i in results], "count": len(results)})
    finally:
        db.close()


def delete_idea(idea_id: int) -> str:
    """Delete an idea."""
    db = _get_db()
    try:
        idea = db.get(Idea, idea_id)
        if not idea:
            return json.dumps({"success": False, "error": f"Idea #{idea_id} not found"})
        title = idea.title
        db.delete(idea)
        db.commit()
        return json.dumps({"success": True, "deleted": title})
    finally:
        db.close()


def list_change_log(limit: int = 20, status: Optional[str] = None) -> str:
    """List recorded changes (newest first)."""
    return change_log_service.list_changes(limit=limit, status=status)


def undo_change(change_id: str) -> str:
    """Undo a specific applied change by ID."""
    result = change_log_service.undo_change(change_id)
    try:
        payload = json.loads(result)
        if payload.get("success"):
            scheduler_wake_event.set()
    except Exception:
        pass
    return result


def undo_last_change() -> str:
    """Undo the most recent applied change."""
    result = change_log_service.undo_last_change()
    try:
        payload = json.loads(result)
        if payload.get("success"):
            scheduler_wake_event.set()
    except Exception:
        pass
    return result
