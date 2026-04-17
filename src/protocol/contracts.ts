import { z } from "zod";

export const PrioritySchema = z.enum(["low", "normal", "high", "urgent"]);
export const TodoStatusSchema = z.enum(["open", "done", "cancelled"]);
export const ReminderStatusSchema = z.enum(["pending", "sent", "cancelled"]);

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
  timezone: z.string().default("UTC"),
  recurrenceRule: z.string().optional(),
  source: z.string().default("tooling"),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const CompleteTodoInputSchema = z.object({
  todoId: z.number().int().positive(),
  userExternalId: z.string().min(1),
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
export type CancelTodoInput = z.input<typeof CancelTodoInputSchema>;
export type ListTodosInput = z.input<typeof ListTodosInputSchema>;
export type SearchTodosInput = z.input<typeof SearchTodosInputSchema>;
export type ListDueRemindersInput = z.input<typeof ListDueRemindersInputSchema>;
export type ListRemindersInput = z.input<typeof ListRemindersInputSchema>;
export type CancelReminderInput = z.input<typeof CancelReminderInputSchema>;

export type ToolProtocolMap = {
  add_todo: AddTodoInput;
  add_reminder: AddReminderInput;
  complete_todo: CompleteTodoInput;
  cancel_todo: CancelTodoInput;
  list_todos: ListTodosInput;
  search_todos: SearchTodosInput;
  list_due_reminders: ListDueRemindersInput;
  list_reminders: ListRemindersInput;
  cancel_reminder: CancelReminderInput;
};
