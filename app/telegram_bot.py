"""Telegram bot — webhook handler that passes messages to the AI agent."""

import logging
from telegram import Update, Bot
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
from app.config import settings
from app import agent
from app.scheduler import set_chat_id

logger = logging.getLogger(__name__)

# Build the Telegram application (used in webhook mode)
application = Application.builder().token(settings.telegram_bot_token).build()


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /start command."""
    await update.message.reply_text(
        "Todo bot. Send me tasks, reminders, or ideas in plain english.\n\n"
        "Examples:\n"
        '- "remind me to buy groceries tomorrow at 9am"\n'
        '- "what\'s due this week"\n'
        '- "mark groceries as done"\n'
        '- "show all my todos"\n'
        '- "idea: build a sleep tracker app"'
    )


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /help command."""
    await update.message.reply_text(
        "What I can do:\n\n"
        "- Add/edit/delete todos with due dates and priorities\n"
        "- Set reminders (I'll message you when they're due)\n"
        "- List, search, and filter tasks\n"
        "- Snooze/reschedule tasks\n"
        "- Save ideas separately from tasks\n\n"
        "Just type normally. No commands needed.",
    )


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle any text message — pass to AI agent."""
    # Capture chat_id for proactive reminders
    set_chat_id(update.message.chat_id)

    user_message = update.message.text
    logger.info(f"Received message: {user_message}")

    try:
        response = await agent.process_message(user_message)
        await update.message.reply_text(response, parse_mode="Markdown")
    except Exception as e:
        logger.error(f"Error processing message: {e}", exc_info=True)
        # Retry without Markdown in case of parse errors
        try:
            await update.message.reply_text(response)
        except Exception:
            await update.message.reply_text(
                "Something went wrong. Try again."
            )


# Register handlers
application.add_handler(CommandHandler("start", start_command))
application.add_handler(CommandHandler("help", help_command))
application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
