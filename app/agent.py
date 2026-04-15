"""AI Agent — uses OpenAI function calling to interpret natural language and manage todos."""

import json
from collections import deque
from datetime import datetime
from zoneinfo import ZoneInfo
from openai import OpenAI
from app.config import settings
from app import service

EASTERN = ZoneInfo("America/New_York")

client = OpenAI(api_key=settings.openai_api_key)

# Conversation history — last 20 exchanges (user + assistant + tool calls)
# Keeps context for "change that", "the one I just added", etc.
MAX_HISTORY = 40  # 20 exchanges ≈ 40 messages (user + assistant pairs)
conversation_history: deque = deque(maxlen=MAX_HISTORY)

SYSTEM_PROMPT = """You are a personal todo/reminder assistant.

Current date/time (US Eastern): {now_eastern}

You help the user manage their tasks by interpreting natural language and calling the appropriate functions.

CRITICAL DATE RULES:
- All dates are in US Eastern time. Today is {today_eastern} ({day_of_week}).
- When the user says "tomorrow", that means {today_eastern} + 1 day. "Friday" means the NEXT upcoming Friday from {today_eastern}.
- ALWAYS convert relative dates to YYYY-MM-DD before calling any function. Double-check your date math.
- If you're unsure about a date, call get_current_datetime first to confirm.
- NEVER guess dates — use the date provided above or call get_current_datetime.

REMINDER RULES:
- When the user says "remind me to X at TIME", create a todo with add_todo FIRST, then use the returned todo ID to create a reminder with add_reminder.
- remind_at must be in ISO format: YYYY-MM-DDTHH:MM (e.g. 2026-04-15T09:00). Always use Eastern time.
- A reminder is a notification schedule attached to a todo. Multiple reminders can exist per todo.
- When listing reminders, show the time and linked todo clearly.

Guidelines:
- When the user says "add X" without mentioning a reminder time, just use add_todo (no reminder).
- When the user says "remind me to X at TIME" or "remind me about X tomorrow morning", create the todo AND a reminder.
- When listing todos, format them cleanly: show title, due date, priority, and ID. No emojis.
- When the user asks "what's due today/this week", use the appropriate function.
- If a user wants to complete or delete a todo but doesn't give an ID, search for it first, then confirm which one.
- Keep responses short and direct. No filler, no cheerfulness, no emojis. Just the information.
- If the user's message isn't about todos, respond briefly.
- For priority, default to "medium" unless the user specifies urgency.
- When the user says "I have an idea", "jot this down", "idea:", or similar, use add_idea — NOT add_todo. Ideas are separate from tasks.
"""

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "add_todo",
            "description": "Add a new todo/reminder/task",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "The task title/name"},
                    "description": {"type": "string", "description": "Optional details about the task"},
                    "due_date": {"type": "string", "description": "Due date in YYYY-MM-DD format"},
                    "priority": {
                        "type": "string",
                        "enum": ["low", "medium", "high"],
                        "description": "Task priority (default: medium)",
                    },
                },
                "required": ["title"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_todos",
            "description": "List todos with optional filters for status, date range, and priority",
            "parameters": {
                "type": "object",
                "properties": {
                    "status": {
                        "type": "string",
                        "enum": ["pending", "done"],
                        "description": "Filter by status",
                    },
                    "due_before": {"type": "string", "description": "Show todos due on or before this date (YYYY-MM-DD)"},
                    "due_after": {"type": "string", "description": "Show todos due on or after this date (YYYY-MM-DD)"},
                    "priority": {
                        "type": "string",
                        "enum": ["low", "medium", "high"],
                        "description": "Filter by priority",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "complete_todo",
            "description": "Mark a todo as done/completed",
            "parameters": {
                "type": "object",
                "properties": {
                    "todo_id": {"type": "integer", "description": "The ID of the todo to complete"},
                },
                "required": ["todo_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "delete_todo",
            "description": "Delete a todo permanently",
            "parameters": {
                "type": "object",
                "properties": {
                    "todo_id": {"type": "integer", "description": "The ID of the todo to delete"},
                },
                "required": ["todo_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_todos",
            "description": "Search todos by keyword in title or description",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search keyword"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_current_datetime",
            "description": "Get the current date and time in US Eastern timezone. Call this whenever you need to confirm what day/time it is.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_due_today",
            "description": "Get all pending todos due today",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_due_this_week",
            "description": "Get all pending todos due this week",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "snooze_todo",
            "description": "Reschedule/snooze a todo to a new date",
            "parameters": {
                "type": "object",
                "properties": {
                    "todo_id": {"type": "integer", "description": "The ID of the todo to snooze"},
                    "new_due_date": {"type": "string", "description": "New due date (YYYY-MM-DD)"},
                },
                "required": ["todo_id", "new_due_date"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_todo",
            "description": "Edit an existing todo's title, description, due date, or priority",
            "parameters": {
                "type": "object",
                "properties": {
                    "todo_id": {"type": "integer", "description": "The ID of the todo to edit"},
                    "title": {"type": "string", "description": "New title"},
                    "description": {"type": "string", "description": "New description"},
                    "due_date": {"type": "string", "description": "New due date (YYYY-MM-DD)"},
                    "priority": {"type": "string", "enum": ["low", "medium", "high"], "description": "New priority"},
                },
                "required": ["todo_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "add_reminder",
            "description": "Add a reminder notification for an existing todo. The bot will proactively message the user at the specified time.",
            "parameters": {
                "type": "object",
                "properties": {
                    "todo_id": {"type": "integer", "description": "The ID of the todo to set a reminder for"},
                    "remind_at": {"type": "string", "description": "When to send the reminder, in ISO format YYYY-MM-DDTHH:MM (Eastern time)"},
                },
                "required": ["todo_id", "remind_at"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_reminders",
            "description": "List upcoming (unsent) reminders, optionally filtered by todo",
            "parameters": {
                "type": "object",
                "properties": {
                    "todo_id": {"type": "integer", "description": "Filter reminders for a specific todo"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "cancel_reminder",
            "description": "Cancel/delete a specific reminder by its ID",
            "parameters": {
                "type": "object",
                "properties": {
                    "reminder_id": {"type": "integer", "description": "The ID of the reminder to cancel"},
                },
                "required": ["reminder_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "add_idea",
            "description": "Jot down an idea for later. Not a task — just a thought to capture.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "The idea in brief"},
                    "description": {"type": "string", "description": "More detail about the idea"},
                    "category": {"type": "string", "description": "Optional category (e.g. project, app, business, personal)"},
                },
                "required": ["title"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_ideas",
            "description": "List all saved ideas, optionally filtered by category",
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {"type": "string", "description": "Filter by category"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_ideas",
            "description": "Search ideas by keyword",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search keyword"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "delete_idea",
            "description": "Delete an idea",
            "parameters": {
                "type": "object",
                "properties": {
                    "idea_id": {"type": "integer", "description": "The ID of the idea to delete"},
                },
                "required": ["idea_id"],
            },
        },
    },
]

# Map function names to actual Python functions
TOOL_MAP = {
    "add_todo": service.add_todo,
    "list_todos": service.list_todos,
    "complete_todo": service.complete_todo,
    "delete_todo": service.delete_todo,
    "search_todos": service.search_todos,
    "get_current_datetime": service.get_current_datetime,
    "get_due_today": service.get_due_today,
    "get_due_this_week": service.get_due_this_week,
    "snooze_todo": service.snooze_todo,
    "edit_todo": service.edit_todo,
    "add_reminder": service.add_reminder,
    "list_reminders": service.list_reminders,
    "cancel_reminder": service.cancel_reminder,
    "add_idea": service.add_idea,
    "list_ideas": service.list_ideas,
    "search_ideas": service.search_ideas,
    "delete_idea": service.delete_idea,
}


async def process_message(user_message: str) -> str:
    """Process a user message through the AI agent and return the response."""
    now = datetime.now(EASTERN)
    today_str = now.date().isoformat()
    day_of_week = now.strftime("%A")
    now_str = now.strftime("%Y-%m-%d %I:%M %p %Z")
    system_prompt = (
        SYSTEM_PROMPT
        .replace("{now_eastern}", now_str)
        .replace("{today_eastern}", today_str)
        .replace("{day_of_week}", day_of_week)
    )

    # Build messages: system prompt + conversation history + new user message
    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(list(conversation_history))
    messages.append({"role": "user", "content": user_message})

    # Track new messages from this turn to add to history later
    new_history_messages = [{"role": "user", "content": user_message}]

    # Loop to handle multiple tool calls if needed
    for _ in range(5):  # max iterations to prevent infinite loops
        response = client.chat.completions.create(
            model=settings.openai_model,
            messages=messages,
            tools=TOOLS,
            tool_choice="auto",
        )

        message = response.choices[0].message

        # If no tool calls, return the text response
        if not message.tool_calls:
            reply = message.content or "I'm not sure how to help with that."
            new_history_messages.append({"role": "assistant", "content": reply})
            # Save this exchange to history
            for msg in new_history_messages:
                conversation_history.append(msg)
            return reply

        # Process each tool call
        messages.append(message)
        # Store a simplified version of the assistant tool-call message for history
        new_history_messages.append({
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                }
                for tc in message.tool_calls
            ],
        })

        for tool_call in message.tool_calls:
            fn_name = tool_call.function.name
            fn_args = json.loads(tool_call.function.arguments)

            fn = TOOL_MAP.get(fn_name)
            if fn:
                result = fn(**fn_args)
            else:
                result = json.dumps({"error": f"Unknown function: {fn_name}"})

            tool_msg = {
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": result,
            }
            messages.append(tool_msg)
            new_history_messages.append(tool_msg)

    reply = "Sorry, I had trouble processing that. Please try again."
    new_history_messages.append({"role": "assistant", "content": reply})
    for msg in new_history_messages:
        conversation_history.append(msg)
    return reply
