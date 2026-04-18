import { z } from "zod";
import { DEFAULT_TIMEZONE } from "../config.js";

export const PrioritySchema = z.enum(["low", "normal", "high", "urgent"]);
export const TodoStatusSchema = z.enum(["open", "done", "cancelled"]);
export const ReminderStatusSchema = z.enum(["pending", "sent", "cancelled"]);

function isValidRecurrenceRule(rule: string): boolean {
  const parts = rule
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) return false;

  const kv = new Map<string, string>();
  for (const part of parts) {
    const [rawKey, ...rest] = part.split("=");
    const key = rawKey?.trim().toUpperCase();
    const value = rest.join("=").trim();
    if (!key || !value) continue;
    kv.set(key, value);
  }

  const freq = kv.get("FREQ")?.toUpperCase();
  if (!freq || !["MINUTELY", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) {
    return false;
  }

  const intervalRaw = kv.get("INTERVAL");
  if (intervalRaw !== undefined) {
    const interval = Number.parseInt(intervalRaw, 10);
    if (!Number.isFinite(interval) || interval <= 0) return false;
  }

  const countRaw = kv.get("COUNT");
  if (countRaw !== undefined) {
    const count = Number.parseInt(countRaw, 10);
    if (!Number.isFinite(count) || count <= 0) return false;
  }

  const untilRaw = kv.get("UNTIL");
  if (untilRaw !== undefined) {
    const compactUtc = /^\d{8}T\d{6}Z$/.test(untilRaw);
    const compactDate = /^\d{8}$/.test(untilRaw);
    const iso = Date.parse(untilRaw);
    if (!compactUtc && !compactDate && !Number.isFinite(iso)) {
      return false;
    }
  }

  return true;
}

export const AddTodoInputSchema = z.object({
  userExternalId: z.string().min(1),
  title: z.string().min(1),
  notes: z.string().optional(),
  dueAt: z.string().datetime({ offset: true }).optional(),
  priority: PrioritySchema.optional().default("normal"),
  source: z.string().default("tooling"),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const AddReminderInputSchema = z.object({
  userExternalId: z.string().min(1),
  todoId: z.number().int().positive().optional(),
  text: z.string().min(1),
  remindAt: z.string().datetime({ offset: true }),
  timezone: z.string().default(DEFAULT_TIMEZONE),
  recurrenceRule: z.string().refine((value) => isValidRecurrenceRule(value), {
    message:
      "Invalid recurrenceRule. Supported: FREQ=MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY with optional INTERVAL, COUNT, UNTIL",
  }).optional(),
  source: z.string().default("tooling"),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const CompleteTodoInputSchema = z.object({
  todoId: z.number().int().positive(),
  userExternalId: z.string().min(1),
});

export const UpdateTodoInputSchema = z
  .object({
    todoId: z.number().int().positive(),
    userExternalId: z.string().min(1),
    title: z.string().min(1).optional(),
    notes: z.string().optional(),
    clearNotes: z.boolean().optional().default(false),
    priority: PrioritySchema.optional(),
    dueAt: z.string().datetime({ offset: true }).optional(),
    clearDueAt: z.boolean().optional().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.clearNotes && value.notes !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Use notes or clearNotes=true, not both",
        path: ["notes"],
      });
    }

    if (value.clearDueAt && value.dueAt !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Use dueAt or clearDueAt=true, not both",
        path: ["dueAt"],
      });
    }

    if (
      value.title === undefined &&
      value.notes === undefined &&
      !value.clearNotes &&
      value.priority === undefined &&
      value.dueAt === undefined &&
      !value.clearDueAt
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide at least one field to update",
        path: ["todoId"],
      });
    }
  });

export const CancelTodoInputSchema = z.object({
  todoId: z.number().int().positive(),
  userExternalId: z.string().min(1),
});

export const ListTodosInputSchema = z.object({
  userExternalId: z.string().min(1),
  status: TodoStatusSchema.optional(),
  dueBefore: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().positive().max(1000).default(50),
});

export const SearchTodosInputSchema = z.object({
  userExternalId: z.string().min(1),
  query: z.string().optional(),
  includeDone: z.boolean().default(true),
  includeCancelled: z.boolean().default(false),
  olderThanDays: z.number().int().positive().max(36500).optional(),
  limit: z.number().int().positive().max(1000).default(200),
  sort: z.enum(["recent", "oldest", "due"]).default("recent"),
});

export const UpdateReminderInputSchema = z
  .object({
    reminderId: z.number().int().positive(),
    userExternalId: z.string().min(1),
    text: z.string().min(1).optional(),
    remindAt: z.string().datetime({ offset: true }).optional(),
    timezone: z.string().optional(),
    recurrenceRule: z
      .string()
      .refine((value) => isValidRecurrenceRule(value), {
        message:
          "Invalid recurrenceRule. Supported: FREQ=MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY with optional INTERVAL, COUNT, UNTIL",
      })
      .optional(),
    clearRecurrenceRule: z.boolean().optional().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.clearRecurrenceRule && value.recurrenceRule !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Use recurrenceRule or clearRecurrenceRule=true, not both",
        path: ["recurrenceRule"],
      });
    }

    if (
      value.text === undefined &&
      value.remindAt === undefined &&
      value.timezone === undefined &&
      value.recurrenceRule === undefined &&
      !value.clearRecurrenceRule
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide at least one field to update",
        path: ["reminderId"],
      });
    }
  });

export const ListDueRemindersInputSchema = z.object({
  userExternalId: z.string().min(1),
  asOf: z.string().datetime({ offset: true }),
  limit: z.number().int().positive().max(200).default(100),
});

export const ListRemindersInputSchema = z.object({
  userExternalId: z.string().min(1),
  status: ReminderStatusSchema.optional(),
  todoId: z.number().int().positive().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().positive().max(1000).default(200),
});

export const CancelReminderInputSchema = z.object({
  reminderId: z.number().int().positive(),
  userExternalId: z.string().min(1),
});

export type AddTodoInput = z.input<typeof AddTodoInputSchema>;
export type AddReminderInput = z.input<typeof AddReminderInputSchema>;
export type CompleteTodoInput = z.input<typeof CompleteTodoInputSchema>;
export type UpdateTodoInput = z.input<typeof UpdateTodoInputSchema>;
export type CancelTodoInput = z.input<typeof CancelTodoInputSchema>;
export type UpdateReminderInput = z.input<typeof UpdateReminderInputSchema>;
export type ListTodosInput = z.input<typeof ListTodosInputSchema>;
export type SearchTodosInput = z.input<typeof SearchTodosInputSchema>;
export type ListDueRemindersInput = z.input<typeof ListDueRemindersInputSchema>;
export type ListRemindersInput = z.input<typeof ListRemindersInputSchema>;
export type CancelReminderInput = z.input<typeof CancelReminderInputSchema>;

export type ToolProtocolMap = {
  add_todo: AddTodoInput;
  add_reminder: AddReminderInput;
  complete_todo: CompleteTodoInput;
  update_todo: UpdateTodoInput;
  cancel_todo: CancelTodoInput;
  update_reminder: UpdateReminderInput;
  list_todos: ListTodosInput;
  search_todos: SearchTodosInput;
  list_due_reminders: ListDueRemindersInput;
  list_reminders: ListRemindersInput;
  cancel_reminder: CancelReminderInput;
};
