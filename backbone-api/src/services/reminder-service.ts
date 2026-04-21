import { DateTime } from "luxon";
import type { DB } from "../db/client.js";
import { withDefaultTimezone } from "../config.js";
import type { Reminder } from "../models.js";
import {
  AddReminderInputSchema,
  UpdateReminderInputSchema,
  ListDueRemindersInputSchema,
  ListRemindersInputSchema,
  CancelReminderInputSchema,
  type AddReminderInput,
  type UpdateReminderInput,
  type ListDueRemindersInput,
  type ListRemindersInput,
  type CancelReminderInput,
} from "../protocol/contracts.js";
import { UserService } from "./user-service.js";
import { nowIso } from "../time/protocol.js";

interface ReminderRow {
  id: number;
  user_id: number;
  todo_id: number | null;
  text: string;
  remind_at: string;
  timezone: string;
  recurrence_rule: string | null;
  status: Reminder["status"];
  source: string;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
}

type RecurrenceFrequency = "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

type ParsedRecurrenceRule = {
  frequency: RecurrenceFrequency;
  interval: number;
  count?: number;
  untilUtcIso?: string;
};

function parseUntilToUtcIso(raw: string): string | null {
  const value = raw.trim();

  const iso = DateTime.fromISO(value, { zone: "utc" });
  if (iso.isValid) return iso.toUTC().toISO() ?? null;

  const compactUtc = DateTime.fromFormat(value, "yyyyMMdd'T'HHmmss'Z'", { zone: "utc" });
  if (compactUtc.isValid) return compactUtc.toUTC().toISO() ?? null;

  const compactDate = DateTime.fromFormat(value, "yyyyMMdd", { zone: "utc" });
  if (compactDate.isValid) return compactDate.endOf("day").toUTC().toISO() ?? null;

  return null;
}

function parseRecurrenceRule(rule: string): ParsedRecurrenceRule | null {
  const parts = rule
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);

  const kv = new Map<string, string>();
  for (const part of parts) {
    const [rawKey, ...rest] = part.split("=");
    const key = rawKey?.trim().toUpperCase();
    const value = rest.join("=").trim();
    if (!key || !value) continue;
    kv.set(key, value);
  }

  const frequency = kv.get("FREQ")?.toUpperCase() as RecurrenceFrequency | undefined;
  if (!frequency || !["MINUTELY", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(frequency)) {
    return null;
  }

  const intervalRaw = kv.get("INTERVAL");
  const interval = intervalRaw ? Number.parseInt(intervalRaw, 10) : 1;
  if (!Number.isFinite(interval) || interval <= 0) return null;

  const countRaw = kv.get("COUNT");
  const count = countRaw ? Number.parseInt(countRaw, 10) : undefined;
  if (count !== undefined && (!Number.isFinite(count) || count <= 0)) return null;

  const untilRaw = kv.get("UNTIL");
  const untilParsed = untilRaw ? parseUntilToUtcIso(untilRaw) : null;
  if (untilRaw && !untilParsed) return null;
  const untilUtcIso = untilParsed ?? undefined;

  return { frequency, interval, count, untilUtcIso };
}

function computeNextReminderAt(remindAtIso: string, recurrenceRule: ParsedRecurrenceRule, timezone?: string): string | null {
  const zone = withDefaultTimezone(timezone);
  const base = DateTime.fromISO(remindAtIso, { zone: "utc" }).setZone(zone);
  if (!base.isValid) return null;

  let next = base;
  switch (recurrenceRule.frequency) {
    case "MINUTELY":
      next = base.plus({ minutes: recurrenceRule.interval });
      break;
    case "HOURLY":
      next = base.plus({ hours: recurrenceRule.interval });
      break;
    case "DAILY":
      next = base.plus({ days: recurrenceRule.interval });
      break;
    case "WEEKLY":
      next = base.plus({ weeks: recurrenceRule.interval });
      break;
    case "MONTHLY":
      next = base.plus({ months: recurrenceRule.interval });
      break;
    case "YEARLY":
      next = base.plus({ years: recurrenceRule.interval });
      break;
  }

  if (!next.isValid) return null;
  const nextUtc = next.toUTC().toISO();
  if (!nextUtc) return null;
  if (Date.parse(nextUtc) <= Date.parse(remindAtIso)) return null;

  if (recurrenceRule.untilUtcIso && Date.parse(nextUtc) > Date.parse(recurrenceRule.untilUtcIso)) {
    return null;
  }

  return nextUtc;
}

function parseReminderMetadata(metadataJson: string | null): Record<string, unknown> {
  if (!metadataJson) return {};
  try {
    const parsed = JSON.parse(metadataJson) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function mapReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    userId: row.user_id,
    todoId: row.todo_id,
    text: row.text,
    remindAt: row.remind_at,
    timezone: row.timezone,
    recurrenceRule: row.recurrence_rule,
    status: row.status,
    source: row.source,
    metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at,
  };
}

export class ReminderService {
  private readonly users: UserService;

  constructor(private readonly db: DB) {
    this.users = new UserService(db);
  }

  addReminder(input: AddReminderInput): Reminder {
    const parsed = AddReminderInputSchema.parse(input);
    const userId = this.users.ensureUser(parsed.userExternalId, parsed.timezone);

    if (parsed.todoId !== undefined) {
      const todoRow = this.db
        .prepare("SELECT id, user_id FROM todos WHERE id = ?")
        .get(parsed.todoId) as { id: number; user_id: number } | undefined;

      if (!todoRow) {
        throw new Error(`Todo ${parsed.todoId} not found`);
      }
      if (todoRow.user_id !== userId) {
        throw new Error(`Todo ${parsed.todoId} does not belong to user ${parsed.userExternalId}`);
      }
    }

    const metadata = parsed.metadata ? JSON.stringify(parsed.metadata) : null;

    const info = this.db
      .prepare(`
        INSERT INTO reminders (
          user_id, todo_id, text, remind_at, timezone, recurrence_rule, source, metadata_json
        )
        VALUES (@user_id, @todo_id, @text, @remind_at, @timezone, @recurrence_rule, @source, @metadata_json)
      `)
      .run({
        user_id: userId,
        todo_id: parsed.todoId ?? null,
        text: parsed.text,
        remind_at: parsed.remindAt,
        timezone: parsed.timezone,
        recurrence_rule: parsed.recurrenceRule ?? null,
        source: parsed.source,
        metadata_json: metadata,
      });

    const row = this.db
      .prepare("SELECT * FROM reminders WHERE id = ?")
      .get(info.lastInsertRowid) as ReminderRow;

    return mapReminder(row);
  }

  updateReminder(input: UpdateReminderInput): Reminder {
    const parsed = UpdateReminderInputSchema.parse(input);
    const userId = this.users.getUserIdOrThrow(parsed.userExternalId);

    const now = nowIso();
    const sets: string[] = ["updated_at = @updated_at"];
    const params: Record<string, unknown> = {
      updated_at: now,
      reminder_id: parsed.reminderId,
      user_id: userId,
    };

    if (parsed.text !== undefined) {
      sets.push("text = @text");
      params.text = parsed.text;
    }

    if (parsed.remindAt !== undefined) {
      sets.push("remind_at = @remind_at");
      params.remind_at = parsed.remindAt;
    }

    if (parsed.timezone !== undefined) {
      sets.push("timezone = @timezone");
      params.timezone = parsed.timezone;
    }

    if (parsed.todoId !== undefined) {
      const todoRow = this.db
        .prepare("SELECT id, user_id FROM todos WHERE id = ?")
        .get(parsed.todoId) as { id: number; user_id: number } | undefined;

      if (!todoRow) {
        throw new Error(`Todo ${parsed.todoId} not found`);
      }
      if (todoRow.user_id !== userId) {
        throw new Error(`Todo ${parsed.todoId} does not belong to user ${parsed.userExternalId}`);
      }

      sets.push("todo_id = @todo_id");
      params.todo_id = parsed.todoId;
    }

    if (parsed.clearRecurrenceRule) {
      sets.push("recurrence_rule = NULL");
    } else if (parsed.recurrenceRule !== undefined) {
      sets.push("recurrence_rule = @recurrence_rule");
      params.recurrence_rule = parsed.recurrenceRule;
    }

    const updated = this.db
      .prepare(
        `
          UPDATE reminders
          SET ${sets.join(", ")}
          WHERE id = @reminder_id AND user_id = @user_id
        `,
      )
      .run(params);

    if (updated.changes === 0) {
      throw new Error(`Reminder ${parsed.reminderId} not found for user ${parsed.userExternalId}`);
    }

    const row = this.db
      .prepare("SELECT * FROM reminders WHERE id = ?")
      .get(parsed.reminderId) as ReminderRow;

    return mapReminder(row);
  }

  listDueReminders(input: ListDueRemindersInput): Reminder[] {
    const parsed = ListDueRemindersInputSchema.parse(input);

    const userId = this.users.getUserIdOrNull(parsed.userExternalId);
    if (userId === null) return [];

    const rows = this.db
      .prepare(`
        SELECT * FROM reminders
        WHERE user_id = @user_id
          AND status = 'pending'
          AND remind_at <= @as_of
        ORDER BY remind_at ASC, id ASC
        LIMIT @limit
      `)
      .all({
        user_id: userId,
        as_of: parsed.asOf,
        limit: parsed.limit,
      }) as ReminderRow[];

    return rows.map(mapReminder);
  }

  markReminderSent(reminderId: number): Reminder {
    const now = nowIso();

    const existing = this.db.prepare("SELECT * FROM reminders WHERE id = ?").get(reminderId) as ReminderRow | undefined;
    if (!existing) {
      throw new Error(`Reminder ${reminderId} not found`);
    }

    const recurrence = existing.recurrence_rule ? parseRecurrenceRule(existing.recurrence_rule) : null;
    const metadata = parseReminderMetadata(existing.metadata_json);
    const sentCountRaw = Number(metadata.recurrenceSentCount ?? 0);
    const sentCount = Number.isFinite(sentCountRaw) && sentCountRaw >= 0 ? Math.floor(sentCountRaw) : 0;
    const nextSentCount = sentCount + 1;

    metadata.recurrenceSentCount = nextSentCount;
    metadata.lastSentAt = now;
    const nextMetadataJson = JSON.stringify(metadata);

    const reachesCountLimit = recurrence?.count !== undefined && nextSentCount >= recurrence.count;
    const nextRemindAt = recurrence && !reachesCountLimit
      ? computeNextReminderAt(existing.remind_at, recurrence, existing.timezone)
      : null;

    if (nextRemindAt) {
      this.db
        .prepare(
          `
            UPDATE reminders
            SET status = 'pending',
                remind_at = ?,
                sent_at = ?,
                metadata_json = ?,
                updated_at = ?
            WHERE id = ?
          `,
        )
        .run(nextRemindAt, now, nextMetadataJson, now, reminderId);
    } else {
      this.db
        .prepare(
          `
            UPDATE reminders
            SET status = 'sent',
                sent_at = ?,
                metadata_json = ?,
                updated_at = ?
            WHERE id = ?
          `,
        )
        .run(now, nextMetadataJson, now, reminderId);
    }

    const row = this.db.prepare("SELECT * FROM reminders WHERE id = ?").get(reminderId) as ReminderRow;
    return mapReminder(row);
  }

  cancelReminder(input: CancelReminderInput): Reminder {
    const parsed = CancelReminderInputSchema.parse(input);
    const userId = this.users.getUserIdOrThrow(parsed.userExternalId);

    const now = nowIso();
    const result = this.db
      .prepare(
        `
          UPDATE reminders
          SET status = 'cancelled',
              updated_at = ?
          WHERE id = ? AND user_id = ?
        `,
      )
      .run(now, parsed.reminderId, userId);

    if (result.changes === 0) {
      throw new Error(`Reminder ${parsed.reminderId} not found for user ${parsed.userExternalId}`);
    }

    const row = this.db
      .prepare("SELECT * FROM reminders WHERE id = ?")
      .get(parsed.reminderId) as ReminderRow;

    return mapReminder(row);
  }

  cancelPendingForTodoId(todoId: number): number {
    const now = nowIso();
    const result = this.db
      .prepare(
        `
          UPDATE reminders
          SET status = 'cancelled',
              updated_at = ?
          WHERE todo_id = ? AND status = 'pending'
        `,
      )
      .run(now, todoId);

    return result.changes;
  }

  listReminders(input: ListRemindersInput): Reminder[] {
    const parsed = ListRemindersInputSchema.parse(input);

    const userId = this.users.getUserIdOrNull(parsed.userExternalId);
    if (userId === null) return [];

    const where: string[] = ["user_id = @user_id"];
    const params: Record<string, unknown> = {
      user_id: userId,
      limit: parsed.limit,
    };

    if (parsed.status) {
      where.push("status = @status");
      params.status = parsed.status;
    }

    if (parsed.todoId !== undefined) {
      where.push("todo_id = @todo_id");
      params.todo_id = parsed.todoId;
    }

    if (parsed.from) {
      where.push("remind_at >= @from");
      params.from = parsed.from;
    }

    if (parsed.to) {
      where.push("remind_at <= @to");
      params.to = parsed.to;
    }

    const sql = `
      SELECT * FROM reminders
      WHERE ${where.join(" AND ")}
      ORDER BY remind_at ASC, id DESC
      LIMIT @limit
    `;

    const rows = this.db.prepare(sql).all(params) as ReminderRow[];
    return rows.map(mapReminder);
  }

  listAllForUser(userExternalId: string, limit = 100): Reminder[] {
    return this.listReminders({ userExternalId, limit });
  }

  claimReminderForDispatch(
    reminderId: number,
    options?: { claimToken?: string; staleAfterSeconds?: number },
  ): boolean {
    const now = nowIso();
    const staleAfterSeconds = options?.staleAfterSeconds ?? 120;
    const staleBefore = new Date(Date.parse(now) - staleAfterSeconds * 1000).toISOString();
    const claimToken = options?.claimToken ?? `${reminderId}:${now}`;

    const result = this.db
      .prepare(
        `
          INSERT INTO reminder_dispatch_receipts (
            reminder_id,
            claim_token,
            claimed_at,
            sent_at,
            attempts,
            last_error,
            updated_at
          )
          VALUES (?, ?, ?, NULL, 1, NULL, ?)
          ON CONFLICT(reminder_id)
          DO UPDATE SET
            claim_token = excluded.claim_token,
            claimed_at = excluded.claimed_at,
            attempts = reminder_dispatch_receipts.attempts + 1,
            last_error = NULL,
            updated_at = excluded.updated_at
          WHERE reminder_dispatch_receipts.sent_at IS NULL
            AND reminder_dispatch_receipts.claimed_at <= ?
        `,
      )
      .run(reminderId, claimToken, now, now, staleBefore);

    return result.changes > 0;
  }

  markReminderDispatchSent(reminderId: number, claimToken?: string): void {
    const now = nowIso();

    const reminder = this.db
      .prepare("SELECT status FROM reminders WHERE id = ?")
      .get(reminderId) as { status: Reminder["status"] } | undefined;

    if (reminder?.status === "pending") {
      this.db
        .prepare(
          `
            DELETE FROM reminder_dispatch_receipts
            WHERE reminder_id = ?
              AND (? IS NULL OR claim_token = ?)
          `,
        )
        .run(reminderId, claimToken ?? null, claimToken ?? null);
      return;
    }

    this.db
      .prepare(
        `
          UPDATE reminder_dispatch_receipts
          SET sent_at = ?,
              last_error = NULL,
              updated_at = ?
          WHERE reminder_id = ?
            AND (? IS NULL OR claim_token = ?)
        `,
      )
      .run(now, now, reminderId, claimToken ?? null, claimToken ?? null);
  }

  markReminderDispatchFailed(reminderId: number, errorMessage: string, claimToken?: string): void {
    const now = nowIso();

    this.db
      .prepare(
        `
          UPDATE reminder_dispatch_receipts
          SET last_error = ?,
              updated_at = ?
          WHERE reminder_id = ?
            AND (? IS NULL OR claim_token = ?)
        `,
      )
      .run(errorMessage.slice(0, 2000), now, reminderId, claimToken ?? null, claimToken ?? null);
  }
}
