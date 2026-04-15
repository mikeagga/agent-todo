"""Lightweight plan schema validation (no heavy deps) for low-cost planner pipeline."""

from __future__ import annotations

import re
from typing import Any, Optional

ALLOWED_ACTIONS = {
    "add_todo",
    "edit_todo",
    "complete_todo",
    "delete_todo",
    "add_reminder",
    "cancel_reminder",
    "add_idea",
    "delete_idea",
    "list_todos",
    "list_reminders",
    "list_ideas",
    "get_due_today",
    "get_due_this_week",
    "search_todos",
    "search_ideas",
    "undo_last_change",
    "undo_change",
    "list_change_log",
}

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^\d{2}:\d{2}$")
DATETIME_MIN_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}")


def _is_iso_date(value: Optional[str]) -> bool:
    return bool(value and DATE_RE.match(value))


def _is_time(value: Optional[str]) -> bool:
    return bool(value and TIME_RE.match(value))


def _is_datetime_min(value: Optional[str]) -> bool:
    return bool(value and DATETIME_MIN_RE.match(value))


def validate_plan(plan: dict[str, Any]) -> tuple[bool, Optional[str]]:
    """Validate planner JSON shape and basic field constraints."""
    if not isinstance(plan, dict):
        return False, "Plan must be a JSON object"

    if "actions" not in plan or not isinstance(plan["actions"], list):
        return False, "Plan must include actions[]"

    needs_clarification = bool(plan.get("needs_clarification", False))
    if needs_clarification and not plan.get("clarification_question"):
        return False, "clarification_question is required when needs_clarification=true"

    if not needs_clarification and len(plan["actions"]) == 0:
        return False, "actions[] cannot be empty unless asking a clarification"

    for i, action in enumerate(plan["actions"]):
        if not isinstance(action, dict):
            return False, f"actions[{i}] must be an object"

        action_type = action.get("type")
        if action_type not in ALLOWED_ACTIONS:
            return False, f"actions[{i}].type is invalid: {action_type}"

        due_date = action.get("due_date")
        if due_date is not None and not _is_iso_date(due_date):
            return False, f"actions[{i}].due_date must be YYYY-MM-DD"

        due_time = action.get("due_time")
        if due_time is not None and not _is_time(due_time):
            return False, f"actions[{i}].due_time must be HH:MM"

        if action_type == "add_todo" and not action.get("title"):
            return False, f"actions[{i}] add_todo requires title"

        if action_type in {"edit_todo", "complete_todo", "delete_todo"} and not action.get("target_todo_id"):
            return False, f"actions[{i}] {action_type} requires target_todo_id"

        if action_type == "add_reminder":
            if not action.get("target_todo_id"):
                return False, f"actions[{i}] add_reminder requires target_todo_id"
            reminders = action.get("reminders")
            if not isinstance(reminders, list) or not reminders:
                return False, f"actions[{i}] add_reminder requires reminders[]"

        if action_type == "cancel_reminder" and not action.get("target_reminder_id"):
            return False, f"actions[{i}] cancel_reminder requires target_reminder_id"

        if action_type == "add_idea" and not action.get("title"):
            return False, f"actions[{i}] add_idea requires title"

        if action_type == "delete_idea" and not action.get("target_idea_id"):
            return False, f"actions[{i}] delete_idea requires target_idea_id"

        if action_type == "undo_change" and not action.get("target_change_id"):
            return False, f"actions[{i}] undo_change requires target_change_id"

        if action_type in {"add_todo", "add_reminder"}:
            for r_i, reminder in enumerate(action.get("reminders", [])):
                if not isinstance(reminder, dict):
                    return False, f"actions[{i}].reminders[{r_i}] must be object"
                kind = reminder.get("kind")
                if kind not in {"absolute", "relative_before_due"}:
                    return False, f"actions[{i}].reminders[{r_i}].kind invalid"
                if kind == "absolute" and not _is_datetime_min(reminder.get("remind_at")):
                    return False, f"actions[{i}].reminders[{r_i}].remind_at must be YYYY-MM-DDTHH:MM"
                if kind == "relative_before_due":
                    offset = reminder.get("offset_minutes_before_due")
                    if not isinstance(offset, int) or offset <= 0:
                        return False, f"actions[{i}].reminders[{r_i}].offset_minutes_before_due must be positive int"

    return True, None
