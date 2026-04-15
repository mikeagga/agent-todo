"""Deterministic plan executor: validates targets, dedupes, and applies service calls."""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app import change_log, service

EASTERN = ZoneInfo("America/New_York")


class PlanExecutionError(Exception):
    pass


def _parse_json(raw: str) -> dict[str, Any]:
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {"raw": data}
    except Exception:
        return {"raw": raw}


def _normalize_title(value: str) -> str:
    return " ".join((value or "").strip().lower().split())


def _call(action_name: str, **kwargs) -> dict[str, Any]:
    fn = getattr(service, action_name, None)
    if not fn:
        raise PlanExecutionError(f"Unknown service action: {action_name}")

    before = change_log.capture_before_state(action_name, kwargs)
    raw = fn(**kwargs)
    change_log.record_action_if_mutating(action_name, kwargs, before, raw)
    data = _parse_json(raw)
    return data


def _pending_todos() -> list[dict[str, Any]]:
    data = _parse_json(service.list_todos(status="pending"))
    return data.get("todos", []) if isinstance(data.get("todos", []), list) else []


def _find_duplicate_todo(title: str, due_date: str | None) -> dict[str, Any] | None:
    title_norm = _normalize_title(title)
    for t in _pending_todos():
        if _normalize_title(t.get("title", "")) == title_norm and (t.get("due_date") or None) == (due_date or None):
            return t
    return None


def _find_duplicate_reminder(todo_id: int, remind_at: str) -> dict[str, Any] | None:
    data = _parse_json(service.list_reminders(todo_id=todo_id))
    reminders = data.get("reminders", []) if isinstance(data.get("reminders", []), list) else []
    for r in reminders:
        existing = (r.get("remind_at") or "")[:16]
        if existing == remind_at:
            return r
    return None


def _resolve_reminder_times(action: dict[str, Any], todo_payload: dict[str, Any]) -> list[str]:
    """Return reminder times as YYYY-MM-DDTHH:MM.

    Important: if reminders[] is empty, returns empty list (no implicit reminder creation).
    """
    resolved: list[str] = []
    reminders = action.get("reminders", []) or []
    if not reminders:
        return resolved

    due_date = action.get("due_date") or todo_payload.get("due_date")
    due_time = action.get("due_time")

    for r in reminders:
        kind = r.get("kind")
        if kind == "absolute":
            resolved.append(str(r["remind_at"])[:16])
            continue

        if kind == "relative_before_due":
            if not due_date:
                raise PlanExecutionError("Relative reminder requires due_date")
            if not due_time:
                raise PlanExecutionError("Relative reminder requires due_time (HH:MM)")
            offset = int(r["offset_minutes_before_due"])
            due_dt = datetime.fromisoformat(f"{due_date}T{due_time}").replace(tzinfo=EASTERN)
            remind_dt = due_dt - timedelta(minutes=offset)
            resolved.append(remind_dt.strftime("%Y-%m-%dT%H:%M"))
            continue

        raise PlanExecutionError(f"Unknown reminder kind: {kind}")

    return resolved


def execute_plan(plan: dict[str, Any]) -> str:
    """Apply a validated plan. Returns final user-facing summary."""
    actions = plan.get("actions", [])
    lines: list[str] = []

    for action in actions:
        action_type = action.get("type")

        if action_type == "add_todo":
            title = action["title"].strip()
            due_date = action.get("due_date")
            duplicate = _find_duplicate_todo(title=title, due_date=due_date)

            if duplicate:
                todo = duplicate
                lines.append(f"Todo already exists: #{todo['id']} {todo['title']}")
            else:
                payload = _call(
                    "add_todo",
                    title=title,
                    description=action.get("description"),
                    due_date=due_date,
                    priority=action.get("priority") or "medium",
                )
                if not payload.get("success"):
                    raise PlanExecutionError(payload.get("error") or "Failed to add todo")
                todo = payload["todo"]
                lines.append(f"Added todo #{todo['id']}: {todo['title']}")

            # NO implicit reminders from due_time. Only explicit reminders[].
            for remind_at in _resolve_reminder_times(action, todo):
                if _find_duplicate_reminder(int(todo["id"]), remind_at):
                    lines.append(f"Reminder already exists for todo #{todo['id']} at {remind_at}")
                    continue
                r_payload = _call("add_reminder", todo_id=int(todo["id"]), remind_at=remind_at)
                if r_payload.get("success"):
                    lines.append(f"Added reminder for todo #{todo['id']} at {remind_at}")

            continue

        if action_type == "edit_todo":
            payload = _call(
                "edit_todo",
                todo_id=int(action["target_todo_id"]),
                title=action.get("title"),
                description=action.get("description"),
                due_date=action.get("due_date"),
                priority=action.get("priority"),
            )
            if not payload.get("success"):
                raise PlanExecutionError(payload.get("error") or "Failed to edit todo")
            lines.append(f"Updated todo #{payload['todo']['id']}: {payload['todo']['title']}")
            continue

        if action_type == "complete_todo":
            payload = _call("complete_todo", todo_id=int(action["target_todo_id"]))
            if not payload.get("success"):
                raise PlanExecutionError(payload.get("error") or "Failed to complete todo")
            lines.append(f"Completed todo #{payload['todo']['id']}: {payload['todo']['title']}")
            continue

        if action_type == "delete_todo":
            payload = _call("delete_todo", todo_id=int(action["target_todo_id"]))
            if not payload.get("success"):
                raise PlanExecutionError(payload.get("error") or "Failed to delete todo")
            lines.append(f"Deleted todo: {payload.get('deleted')}")
            continue

        if action_type == "add_reminder":
            todo_id = int(action["target_todo_id"])
            for remind_at in _resolve_reminder_times(action, {}):
                if _find_duplicate_reminder(todo_id, remind_at):
                    lines.append(f"Reminder already exists for todo #{todo_id} at {remind_at}")
                    continue
                payload = _call("add_reminder", todo_id=todo_id, remind_at=remind_at)
                if not payload.get("success"):
                    raise PlanExecutionError(payload.get("error") or "Failed to add reminder")
                lines.append(f"Added reminder for todo #{todo_id} at {remind_at}")
            continue

        if action_type == "cancel_reminder":
            payload = _call("cancel_reminder", reminder_id=int(action["target_reminder_id"]))
            if not payload.get("success"):
                raise PlanExecutionError(payload.get("error") or "Failed to cancel reminder")
            lines.append(f"Canceled reminder #{action['target_reminder_id']}")
            continue

        if action_type == "add_idea":
            payload = _call(
                "add_idea",
                title=action["title"],
                description=action.get("description"),
                category=action.get("category"),
            )
            if not payload.get("success"):
                raise PlanExecutionError(payload.get("error") or "Failed to add idea")
            idea = payload["idea"]
            lines.append(f"Added idea #{idea['id']}: {idea['title']}")
            continue

        if action_type == "delete_idea":
            payload = _call("delete_idea", idea_id=int(action["target_idea_id"]))
            if not payload.get("success"):
                raise PlanExecutionError(payload.get("error") or "Failed to delete idea")
            lines.append(f"Deleted idea: {payload.get('deleted')}")
            continue

        if action_type == "list_todos":
            payload = _call(
                "list_todos",
                status=action.get("status"),
                due_before=action.get("due_before"),
                due_after=action.get("due_after"),
                priority=action.get("priority"),
            )
            todos = payload.get("todos", [])
            if not todos:
                lines.append("No todos found.")
            else:
                lines.append("Todos:")
                for t in todos[:20]:
                    lines.append(
                        f"- #{t['id']} {t['title']} | due: {t.get('due_date') or 'none'} | priority: {t.get('priority')} | status: {t.get('status')}"
                    )
            continue

        if action_type == "list_reminders":
            payload = _call("list_reminders", todo_id=action.get("target_todo_id"))
            reminders = payload.get("reminders", [])
            if not reminders:
                lines.append("No reminders found.")
            else:
                lines.append("Reminders:")
                for r in reminders[:20]:
                    lines.append(f"- #{r['id']} todo #{r['todo_id']} at {r.get('remind_at')}")
            continue

        if action_type == "list_ideas":
            payload = _call("list_ideas", category=action.get("category"))
            ideas = payload.get("ideas", [])
            if not ideas:
                lines.append("No ideas found.")
            else:
                lines.append("Ideas:")
                for i in ideas[:20]:
                    lines.append(f"- #{i['id']} {i['title']}")
            continue

        if action_type == "get_due_today":
            payload = _call("get_due_today")
            todos = payload.get("todos", [])
            if not todos:
                lines.append("Nothing due today.")
            else:
                lines.append("Due today:")
                for t in todos[:20]:
                    lines.append(f"- #{t['id']} {t['title']} (priority: {t.get('priority')})")
            continue

        if action_type == "get_due_this_week":
            payload = _call("get_due_this_week")
            todos = payload.get("todos", [])
            if not todos:
                lines.append("Nothing due this week.")
            else:
                lines.append("Due this week:")
                for t in todos[:20]:
                    lines.append(f"- #{t['id']} {t['title']} (due: {t.get('due_date')})")
            continue

        if action_type == "search_todos":
            payload = _call("search_todos", query=action.get("query") or "")
            todos = payload.get("todos", [])
            if not todos:
                lines.append("No matching todos found.")
            else:
                lines.append("Matching todos:")
                for t in todos[:20]:
                    lines.append(f"- #{t['id']} {t['title']}")
            continue

        if action_type == "search_ideas":
            payload = _call("search_ideas", query=action.get("query") or "")
            ideas = payload.get("ideas", [])
            if not ideas:
                lines.append("No matching ideas found.")
            else:
                lines.append("Matching ideas:")
                for i in ideas[:20]:
                    lines.append(f"- #{i['id']} {i['title']}")
            continue

        if action_type == "undo_last_change":
            payload = _call("undo_last_change")
            if not payload.get("success"):
                raise PlanExecutionError(payload.get("error") or "Failed to undo last change")
            lines.append(f"Undid change {payload.get('undone_change_id')}")
            continue

        if action_type == "undo_change":
            payload = _call("undo_change", change_id=action["target_change_id"])
            if not payload.get("success"):
                raise PlanExecutionError(payload.get("error") or "Failed to undo change")
            lines.append(f"Undid change {payload.get('undone_change_id')}")
            continue

        if action_type == "list_change_log":
            payload = _call("list_change_log", limit=int(action.get("limit") or 20), status=action.get("status"))
            changes = payload.get("changes", [])
            if not changes:
                lines.append("No history entries found.")
            else:
                lines.append("Recent changes:")
                for c in changes[:20]:
                    lines.append(f"- {c['id']} | {c.get('timestamp')} | {c.get('status')}")
            continue

        raise PlanExecutionError(f"Unsupported action type: {action_type}")

    return "\n".join(lines).strip() or "Done."
