# telegram-relay

Standalone Telegram bot + PI relay + reminder delivery webhook.

## Run

```bash
npm install
npm run start
```

## Env

- `TELEGRAM_BOT_TOKEN` (required)
- `TELEGRAM_ALLOWED_CHAT_ID` (optional)
- `TELEGRAM_REMINDER_CHAT_ID` (optional)
- `REMINDER_WEBHOOK_SECRET` (required for webhook verification)
- `RELAY_WEBHOOK_HOST` (default `0.0.0.0`)
- `RELAY_WEBHOOK_PORT` (default `8790`)
- `PI_BIN`, `PI_PROVIDER`, `PI_MODEL`, `PI_EXTRA_ARGS`
- `PI_PROMPT_PREFIX`
- `PI_RPC_IDLE_MINUTES`

## Webhook

- `POST /webhook/reminders`
- HMAC header: `X-Reminder-Signature: sha256=<hex>`

The relay routes reminders based on `userExternalId` (e.g. `tg:<chatId>`). No fallback chat id is used for reminders.
