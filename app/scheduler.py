"""Reminder scheduler — sleeps until the next reminder is due, fires it, repeats."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Optional
from zoneinfo import ZoneInfo
from telegram import Bot
from app.config import settings
from app import service
from app.service import scheduler_wake_event

logger = logging.getLogger(__name__)
EASTERN = ZoneInfo("America/New_York")

# Chat ID storage — captured from first incoming message
_chat_id: Optional[int] = None


def set_chat_id(chat_id: int) -> None:
    global _chat_id
    _chat_id = chat_id


def get_chat_id() -> int | None:
    return _chat_id


async def send_reminder_message(bot: Bot, reminder_info: dict) -> None:
    """Format and send a reminder via Telegram."""
    chat_id = get_chat_id()
    if not chat_id:
        logger.warning("No chat_id stored — cannot send reminder. Message the bot first!")
        return

    title = reminder_info["todo_title"]
    msg = f"🔔 **Reminder:** {title}"
    if reminder_info.get("todo_description"):
        msg += f"\n📝 {reminder_info['todo_description']}"
    if reminder_info.get("todo_due_date"):
        msg += f"\n📅 Due: {reminder_info['todo_due_date']}"
    priority = reminder_info.get("todo_priority")
    if priority == "high":
        msg += "\n🔴 High priority"

    try:
        await bot.send_message(chat_id=chat_id, text=msg, parse_mode="Markdown")
    except Exception:
        # Retry without markdown
        await bot.send_message(chat_id=chat_id, text=msg)


async def scheduler_loop(bot: Bot) -> None:
    """Main scheduler loop — sleeps until next reminder, fires it, repeats."""
    logger.info("Reminder scheduler started")

    while True:
        try:
            # Find the next pending reminder
            next_reminder = service.get_next_pending_reminder()

            if next_reminder is None:
                # Nothing scheduled — sleep until woken
                logger.info("No pending reminders — waiting for wake event")
                await scheduler_wake_event.wait()
                scheduler_wake_event.clear()
                continue

            # Calculate delay until it's due
            now = datetime.now(EASTERN)
            remind_at = next_reminder.remind_at
            # Ensure remind_at is timezone-aware
            if remind_at.tzinfo is None:
                remind_at = remind_at.replace(tzinfo=EASTERN)
            delay = (remind_at - now).total_seconds()

            if delay <= 0:
                # Due right now (or overdue, e.g. server was restarting)
                logger.info(f"Firing overdue reminder #{next_reminder.id}")
                info = service.get_reminder_with_todo(next_reminder.id)
                if info:
                    await send_reminder_message(bot, info)
                service.mark_reminder_sent(next_reminder.id)
                continue

            # Sleep until due OR until woken by a change
            logger.info(
                f"Next reminder #{next_reminder.id} in {delay:.0f}s "
                f"(at {remind_at.strftime('%I:%M %p %Z')})"
            )
            scheduler_wake_event.clear()
            try:
                await asyncio.wait_for(scheduler_wake_event.wait(), timeout=delay)
                # Woken early — something changed, re-query
                scheduler_wake_event.clear()
                logger.info("Scheduler woken — recalculating next reminder")
                continue
            except asyncio.TimeoutError:
                # Timer expired — reminder is due
                logger.info(f"Firing reminder #{next_reminder.id}")
                info = service.get_reminder_with_todo(next_reminder.id)
                if info:
                    await send_reminder_message(bot, info)
                service.mark_reminder_sent(next_reminder.id)

        except Exception as e:
            logger.error(f"Scheduler error: {e}", exc_info=True)
            # Don't crash the loop — wait a bit and retry
            await asyncio.sleep(5)
