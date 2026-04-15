"""AI Agent — low-cost two-phase pipeline (Plan -> deterministic Execute)."""

from __future__ import annotations

import hashlib
import json
from collections import deque
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from openai import OpenAI

from app import change_log, service
from app.config import settings
from app.plan_executor import PlanExecutionError, execute_plan
from app.plan_schema import validate_plan

EASTERN = ZoneInfo("America/New_York")

client = OpenAI(api_key=settings.openai_api_key)

# Keep history short to reduce token usage
MAX_HISTORY = 12  # user + assistant short exchanges
conversation_history: deque = deque(maxlen=MAX_HISTORY)

# very small in-memory idempotency cache for accidental duplicate sends
RECENT_REQUESTS: dict[str, str] = {}
MAX_REQUEST_CACHE = 50

PLANNER_PROMPT = """You are a planning assistant for a todo app.

Return ONLY valid JSON (no markdown) with this shape:
{
  "version": "1.0",
  "needs_clarification": false,
  "clarification_question": null,
  "actions": [
    {
      "type": "add_todo|edit_todo|complete_todo|delete_todo|add_reminder|cancel_reminder|add_idea|delete_idea|list_todos|list_reminders|list_ideas|get_due_today|get_due_this_week|search_todos|search_ideas|undo_last_change|undo_change|list_change_log",
      "title": "optional",
      "description": "optional",
      "priority": "low|medium|high",
      "due_date": "YYYY-MM-DD optional",
      "due_time": "HH:MM optional",
      "target_todo_id": 123,
      "target_reminder_id": 123,
      "target_idea_id": 123,
      "target_change_id": "uuid",
      "query": "optional",
      "status": "pending|done optional",
      "category": "optional",
      "limit": 20,
      "reminders": [
        {
          "kind": "absolute|relative_before_due",
          "remind_at": "YYYY-MM-DDTHH:MM",
          "offset_minutes_before_due": 60
        }
      ]
    }
  ]
}

Rules:
- Due time is NOT a reminder.
- Only include reminders[] when user explicitly asks for reminders.
- If ambiguous between create vs edit, set needs_clarification=true and ask a short question.
- Prefer creating a new todo unless user clearly asked to edit an existing one.
- Use IDs when user provides them.
- Keep actions minimal and correct.
"""


def _json(raw: str) -> dict[str, Any]:
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {"raw": data}
    except Exception:
        return {"raw": raw}


def _recent_context() -> dict[str, Any]:
    todos = _json(service.list_todos(status="pending", priority=None)).get("todos", [])[:10]
    reminders = _json(service.list_reminders()).get("reminders", [])[:10]
    changes = _json(service.list_change_log(limit=5)).get("changes", [])[:5]

    return {
        "pending_todos": [
            {
                "id": t.get("id"),
                "title": t.get("title"),
                "due_date": t.get("due_date"),
                "priority": t.get("priority"),
                "status": t.get("status"),
            }
            for t in todos
        ],
        "reminders": [
            {
                "id": r.get("id"),
                "todo_id": r.get("todo_id"),
                "remind_at": r.get("remind_at"),
            }
            for r in reminders
        ],
        "recent_changes": [
            {
                "id": c.get("id"),
                "status": c.get("status"),
                "timestamp": c.get("timestamp"),
            }
            for c in changes
        ],
    }


def _cache_key(user_message: str) -> str:
    normalized = " ".join(user_message.strip().lower().split())
    now_bucket = datetime.now(EASTERN).strftime("%Y%m%d%H%M")  # 1-minute bucket
    base = f"{now_bucket}:{normalized}"
    return hashlib.sha256(base.encode("utf-8")).hexdigest()


def _set_cached_reply(key: str, reply: str) -> None:
    RECENT_REQUESTS[key] = reply
    if len(RECENT_REQUESTS) > MAX_REQUEST_CACHE:
        # drop oldest inserted item (dict preserves insertion order in py3.7+)
        oldest = next(iter(RECENT_REQUESTS))
        RECENT_REQUESTS.pop(oldest, None)


def _plan_with_llm(user_message: str) -> dict[str, Any]:
    now = datetime.now(EASTERN)
    now_str = now.strftime("%Y-%m-%d %I:%M %p %Z")
    history = list(conversation_history)[-6:]

    planner_input = {
        "current_time_eastern": now_str,
        "conversation_tail": history,
        "context": _recent_context(),
        "user_message": user_message,
    }

    response = client.chat.completions.create(
        model=settings.openai_model,
        temperature=0,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": PLANNER_PROMPT},
            {"role": "user", "content": json.dumps(planner_input)},
        ],
    )

    raw = response.choices[0].message.content or "{}"
    return _json(raw)


async def process_message(user_message: str) -> str:
    """Process message with two-phase flow: Plan (LLM) -> Execute (deterministic)."""
    request_key = _cache_key(user_message)
    if request_key in RECENT_REQUESTS:
        return RECENT_REQUESTS[request_key]

    reply = "Sorry, I had trouble processing that. Please try again."
    plan: dict[str, Any] = {}

    try:
        plan = _plan_with_llm(user_message)
        ok, err = validate_plan(plan)
        if not ok:
            reply = f"I couldn't parse that request safely ({err}). Please rephrase with specifics."
            conversation_history.append({"role": "user", "content": user_message})
            conversation_history.append({"role": "assistant", "content": reply})
            _set_cached_reply(request_key, reply)
            return reply

        if plan.get("needs_clarification"):
            reply = plan.get("clarification_question") or "Do you want me to create a new item or edit an existing one?"
            conversation_history.append({"role": "user", "content": user_message})
            conversation_history.append({"role": "assistant", "content": reply})
            _set_cached_reply(request_key, reply)
            return reply

        change_log.start_recording(user_message)
        notes = None
        try:
            reply = execute_plan(plan)
        except PlanExecutionError as e:
            notes = str(e)
            reply = f"I couldn't apply that safely: {e}"
        except Exception as e:
            notes = str(e)
            raise
        finally:
            change_log.finalize_recording(plan_json=plan, notes=notes)

        conversation_history.append({"role": "user", "content": user_message})
        conversation_history.append({"role": "assistant", "content": reply})
        _set_cached_reply(request_key, reply)
        return reply

    except Exception as e:
        fallback = f"Something went wrong while planning this request: {str(e)}"
        conversation_history.append({"role": "user", "content": user_message})
        conversation_history.append({"role": "assistant", "content": fallback})
        _set_cached_reply(request_key, fallback)
        return fallback
