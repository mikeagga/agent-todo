"""Change log tracking + undo support for agent-applied mutations."""

from __future__ import annotations

import json
from contextvars import ContextVar
from datetime import date, datetime
from typing import Any, Optional

from sqlalchemy import select

from app.database import SessionLocal
from app.models import ChangeLog, Idea, Reminder, Todo

MUTATING_ACTIONS = {
    "add_todo",
    "edit_todo",
    "snooze_todo",
    "complete_todo",
    "delete_todo",
    "add_reminder",
    "cancel_reminder",
    "add_idea",
    "delete_idea",
}

_current_recorder: ContextVar["ChangeRecorder | None"] = ContextVar("change_recorder", default=None)


class ChangeRecorder:
    def __init__(self, user_message: str):
        self.user_message = user_message
        self.actions: list[dict[str, Any]] = []

    def add_action(
        self,
        action_type: str,
        params: dict[str, Any],
        before: Any,
        result: dict[str, Any],
    ) -> None:
        self.actions.append(
            {
                "action_type": action_type,
                "params": params,
                "before": before,
                "result": result,
            }
        )


def _get_db():
    return SessionLocal()


def _parse_json(result: str) -> dict[str, Any]:
    try:
        data = json.loads(result)
        return data if isinstance(data, dict) else {"raw": data}
    except Exception:
        return {"raw": result}


def _todo_snapshot(db, todo_id: int, include_reminders: bool = False) -> Optional[dict[str, Any]]:
    todo = db.get(Todo, todo_id)
    if not todo:
        return None
    snap: dict[str, Any] = {"todo": todo.to_dict()}
    if include_reminders:
        reminders = db.scalars(select(Reminder).where(Reminder.todo_id == todo_id)).all()
        snap["reminders"] = [r.to_dict() for r in reminders]
    return snap


def _reminder_snapshot(db, reminder_id: int) -> Optional[dict[str, Any]]:
    reminder = db.get(Reminder, reminder_id)
    if not reminder:
        return None
    return {"reminder": reminder.to_dict()}


def _idea_snapshot(db, idea_id: int) -> Optional[dict[str, Any]]:
    idea = db.get(Idea, idea_id)
    if not idea:
        return None
    return {"idea": idea.to_dict()}


def capture_before_state(action_type: str, params: dict[str, Any]) -> Any:
    """Capture pre-mutation state needed to undo an action."""
    if action_type not in MUTATING_ACTIONS:
        return None

    db = _get_db()
    try:
        if action_type in {"edit_todo", "snooze_todo"}:
            todo_id = params.get("todo_id")
            if todo_id is None:
                return None
            return _todo_snapshot(db, int(todo_id), include_reminders=False)

        if action_type == "complete_todo":
            todo_id = params.get("todo_id")
            if todo_id is None:
                return None
            return _todo_snapshot(db, int(todo_id), include_reminders=True)

        if action_type == "delete_todo":
            todo_id = params.get("todo_id")
            if todo_id is None:
                return None
            return _todo_snapshot(db, int(todo_id), include_reminders=True)

        if action_type == "cancel_reminder":
            reminder_id = params.get("reminder_id")
            if reminder_id is None:
                return None
            return _reminder_snapshot(db, int(reminder_id))

        if action_type == "delete_idea":
            idea_id = params.get("idea_id")
            if idea_id is None:
                return None
            return _idea_snapshot(db, int(idea_id))

        return None
    finally:
        db.close()


def start_recording(user_message: str) -> None:
    _current_recorder.set(ChangeRecorder(user_message=user_message))


def clear_recording() -> None:
    _current_recorder.set(None)


def record_action_if_mutating(
    action_type: str,
    params: dict[str, Any],
    before: Any,
    result_raw: str,
) -> None:
    recorder = _current_recorder.get()
    if recorder is None or action_type not in MUTATING_ACTIONS:
        return

    result = _parse_json(result_raw)
    if result.get("success") is False:
        return

    recorder.add_action(action_type=action_type, params=params, before=before, result=result)


def finalize_recording(
    *,
    plan_json: Optional[dict[str, Any]] = None,
    notes: Optional[str] = None,
    undo_of: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    recorder = _current_recorder.get()
    if recorder is None:
        return None

    try:
        if not recorder.actions and not undo_of:
            return None

        db = _get_db()
        try:
            row = ChangeLog(
                user_message=recorder.user_message,
                plan_json=plan_json or {"actions": []},
                actions_json=recorder.actions,
                status="applied",
                undo_of=undo_of,
                notes=notes,
            )
            db.add(row)
            db.commit()
            db.refresh(row)
            return row.to_dict()
        finally:
            db.close()
    finally:
        clear_recording()


def _from_iso_date(value: Optional[str]) -> Optional[date]:
    if not value:
        return None
    return date.fromisoformat(value)


def _from_iso_datetime(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    return datetime.fromisoformat(value)


def _restore_todo_fields(todo: Todo, todo_data: dict[str, Any]) -> None:
    todo.title = todo_data.get("title") or todo.title
    todo.description = todo_data.get("description")
    todo.due_date = _from_iso_date(todo_data.get("due_date"))
    if todo_data.get("priority"):
        todo.priority = todo_data["priority"]
    if todo_data.get("status"):
        todo.status = todo_data["status"]


def _undo_action(db, action: dict[str, Any]) -> None:
    action_type = action.get("action_type")
    before = action.get("before") or {}
    result = action.get("result") or {}

    if action_type == "add_todo":
        todo_id = (result.get("todo") or {}).get("id")
        if todo_id is not None:
            todo = db.get(Todo, int(todo_id))
            if todo:
                db.delete(todo)
        return

    if action_type in {"edit_todo", "snooze_todo", "complete_todo"}:
        todo_data = (before or {}).get("todo")
        if not todo_data:
            return
        todo = db.get(Todo, int(todo_data["id"]))
        if not todo:
            return
        _restore_todo_fields(todo, todo_data)

        for reminder_data in (before or {}).get("reminders", []):
            reminder = db.get(Reminder, int(reminder_data["id"]))
            if reminder:
                reminder.sent = bool(reminder_data.get("sent", False))
        return

    if action_type == "delete_todo":
        todo_data = (before or {}).get("todo")
        if not todo_data:
            return
        existing = db.get(Todo, int(todo_data["id"]))
        if existing is None:
            recreated = Todo(
                id=int(todo_data["id"]),
                title=todo_data["title"],
                description=todo_data.get("description"),
                due_date=_from_iso_date(todo_data.get("due_date")),
                priority=todo_data.get("priority") or "medium",
                status=todo_data.get("status") or "pending",
            )
            db.add(recreated)

        for reminder_data in (before or {}).get("reminders", []):
            if db.get(Reminder, int(reminder_data["id"])) is None:
                db.add(
                    Reminder(
                        id=int(reminder_data["id"]),
                        todo_id=int(reminder_data["todo_id"]),
                        remind_at=_from_iso_datetime(reminder_data.get("remind_at")),
                        sent=bool(reminder_data.get("sent", False)),
                    )
                )
        return

    if action_type == "add_reminder":
        reminder_id = (result.get("reminder") or {}).get("id")
        if reminder_id is not None:
            reminder = db.get(Reminder, int(reminder_id))
            if reminder:
                db.delete(reminder)
        return

    if action_type == "cancel_reminder":
        reminder_data = (before or {}).get("reminder")
        if not reminder_data:
            return
        if db.get(Reminder, int(reminder_data["id"])) is None:
            db.add(
                Reminder(
                    id=int(reminder_data["id"]),
                    todo_id=int(reminder_data["todo_id"]),
                    remind_at=_from_iso_datetime(reminder_data.get("remind_at")),
                    sent=bool(reminder_data.get("sent", False)),
                )
            )
        return

    if action_type == "add_idea":
        idea_id = (result.get("idea") or {}).get("id")
        if idea_id is not None:
            idea = db.get(Idea, int(idea_id))
            if idea:
                db.delete(idea)
        return

    if action_type == "delete_idea":
        idea_data = (before or {}).get("idea")
        if not idea_data:
            return
        if db.get(Idea, int(idea_data["id"])) is None:
            db.add(
                Idea(
                    id=int(idea_data["id"]),
                    title=idea_data["title"],
                    description=idea_data.get("description"),
                    category=idea_data.get("category"),
                )
            )
        return


def list_changes(limit: int = 20, status: Optional[str] = None) -> str:
    db = _get_db()
    try:
        query = select(ChangeLog).order_by(ChangeLog.timestamp.desc())
        if status:
            query = query.where(ChangeLog.status == status)
        query = query.limit(limit)
        rows = db.scalars(query).all()
        return json.dumps({"changes": [r.to_dict() for r in rows], "count": len(rows)})
    finally:
        db.close()


def undo_change(change_id: str) -> str:
    db = _get_db()
    try:
        change = db.get(ChangeLog, change_id)
        if not change:
            return json.dumps({"success": False, "error": f"Change {change_id} not found"})
        if change.status != "applied":
            return json.dumps({"success": False, "error": f"Change {change_id} is already reverted"})

        actions = change.actions_json or []
        for action in reversed(actions):
            _undo_action(db, action)

        change.status = "reverted"
        undo_row = ChangeLog(
            user_message=f"undo {change_id}",
            plan_json={"undo": change_id},
            actions_json=[{"undid_change": change_id, "actions_reversed": len(actions)}],
            status="applied",
            undo_of=change_id,
        )
        db.add(undo_row)
        db.commit()
        db.refresh(undo_row)
        return json.dumps({"success": True, "undone_change_id": change_id, "undo_log_id": undo_row.id})
    except Exception as e:
        db.rollback()
        return json.dumps({"success": False, "error": str(e)})
    finally:
        db.close()


def undo_last_change() -> str:
    db = _get_db()
    try:
        row = db.scalars(
            select(ChangeLog)
            .where(ChangeLog.status == "applied", ChangeLog.undo_of.is_(None))
            .order_by(ChangeLog.timestamp.desc())
            .limit(1)
        ).first()
        if not row:
            return json.dumps({"success": False, "error": "No applied changes to undo"})
        target_id = row.id
    finally:
        db.close()

    return undo_change(target_id)
