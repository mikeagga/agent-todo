export type Priority = "low" | "normal" | "high" | "urgent";
export type TodoStatus = "open" | "done" | "cancelled";
export type ReminderStatus = "pending" | "sent" | "cancelled";
export type ConversationStatus = "active" | "closed";
export type PendingActionStatus = "pending" | "confirmed" | "cancelled" | "expired" | "executed";

export interface User {
  id: number;
  externalId: string;
  displayName: string | null;
  timezone: string;
  createdAt: string;
  updatedAt: string;
}

export interface Todo {
  id: number;
  userId: number;
  title: string;
  notes: string | null;
  dueAt: string | null;
  priority: Priority;
  status: TodoStatus;
  source: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface Reminder {
  id: number;
  userId: number;
  todoId: number | null;
  text: string;
  remindAt: string;
  timezone: string;
  recurrenceRule: string | null;
  status: ReminderStatus;
  source: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
}

export interface UserSetting {
  id: number;
  userId: number;
  key: string;
  value: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface UserMemory {
  id: number;
  userId: number;
  key: string;
  value: unknown;
  category: string;
  importance: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSession {
  id: number;
  userId: number;
  status: ConversationStatus;
  startedAt: string;
  lastMessageAt: string;
  closedAt: string | null;
  summary: string | null;
  context: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface PendingAction {
  id: number;
  userId: number;
  conversationSessionId: number | null;
  token: string;
  actionType: string;
  payload: Record<string, unknown>;
  status: PendingActionStatus;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  respondedAt: string | null;
}
