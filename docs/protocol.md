# Todo/Reminder Tool Protocol (v0.1)

This is the tool protocol contract used by the project-local pi extension and bot relay layer.

## Commands

## `resolve_time_expression`

```json
{
  "expression": "tomorrow at 9",
  "timezone": "America/New_York",
  "requireTime": true
}
```

## `add_todo`

```json
{
  "userExternalId": "local-user",
  "title": "buy milk tomorrow",
  "notes": "2%",
  "dueAt": "2026-04-18T10:00:00Z",
  "timeExpression": "tomorrow at 9",
  "timezone": "America/New_York",
  "priority": "normal",
  "source": "tooling"
}
```

## `add_reminder`

```json
{
  "userExternalId": "local-user",
  "todoId": 12,
  "text": "stretch",
  "remindAt": "2026-04-18T14:00:00Z",
  "timeExpression": "tomorrow at 9",
  "timezone": "America/New_York",
  "recurrenceRule": "FREQ=DAILY;INTERVAL=1",
  "source": "tooling"
}
```

## `add_todo_reminder`

```json
{
  "userExternalId": "local-user",
  "todoId": 12,
  "offsetMinutesBeforeDue": 60,
  "text": "Reminder: play pokemon"
}
```

## `complete_todo`

```json
{
  "userExternalId": "local-user",
  "todoId": 12,
  "confirmed": true,
  "confirmationToken": "token-from-confirmation_required-response"
}
```

## `list_todos`

```json
{
  "userExternalId": "local-user",
  "status": "open",
  "dueBefore": "2026-04-20T00:00:00Z",
  "limit": 50
}
```

## `search_todos`

```json
{
  "userExternalId": "local-user",
  "query": "tax",
  "includeDone": true,
  "includeCancelled": false,
  "olderThanDays": 30,
  "sort": "recent",
  "limit": 200
}
```

## `list_due_reminders`

```json
{
  "userExternalId": "local-user",
  "asOf": "2026-04-18T14:00:00Z",
  "limit": 100
}
```

## `list_reminders`

```json
{
  "userExternalId": "local-user",
  "status": "pending",
  "todoId": 12,
  "from": "2026-04-18T00:00:00Z",
  "to": "2026-04-30T23:59:59Z",
  "limit": 200
}
```

## `cancel_todo`

```json
{
  "userExternalId": "local-user",
  "todoId": 12,
  "confirmed": true,
  "confirmationToken": "token-from-confirmation_required-response"
}
```

## `cancel_reminder`

```json
{
  "userExternalId": "local-user",
  "reminderId": 8,
  "confirmed": true,
  "confirmationToken": "token-from-confirmation_required-response"
}
```

---

All date-time values are ISO 8601 UTC strings.

If a reminder is linked via `todoId`, completing/cancelling that todo auto-cancels pending linked reminders.

Clarification responses are structured for relays (e.g. Telegram):

```json
{
  "responseType": "clarification",
  "needsClarification": true,
  "question": "What exact time should I use?"
}
```

Destructive actions can return confirmation requests:

```json
{
  "responseType": "confirmation_required",
  "needsClarification": true,
  "question": "Please confirm: cancel_todo #12. Reply with \"yes\" and I will proceed.",
  "confirmationToken": "...",
  "expiresAt": "2026-04-18T10:15:00.000Z"
}
```
