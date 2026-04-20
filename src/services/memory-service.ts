import { randomUUID } from "node:crypto";
import type { DB } from "../db/client.js";
import type {
  ConversationSession,
  PendingAction,
  PendingActionStatus,
  UserMemory,
  UserSetting,
} from "../models.js";
import { UserService } from "./user-service.js";
import { nowIso } from "../time/protocol.js";

interface ConversationSessionRow {
  id: number;
  user_id: number;
  status: ConversationSession["status"];
  started_at: string;
  last_message_at: string;
  closed_at: string | null;
  summary: string | null;
  context_json: string | null;
  created_at: string;
  updated_at: string;
}

interface PendingActionRow {
  id: number;
  user_id: number;
  conversation_session_id: number | null;
  token: string;
  action_type: string;
  payload_json: string;
  status: PendingAction["status"];
  expires_at: string;
  created_at: string;
  updated_at: string;
  responded_at: string | null;
}

interface UserSettingRow {
  id: number;
  user_id: number;
  key: string;
  value_json: string;
  created_at: string;
  updated_at: string;
}

interface UserMemoryRow {
  id: number;
  user_id: number;
  key: string;
  value_json: string;
  category: string;
  importance: number;
  created_at: string;
  updated_at: string;
}

function mapConversation(row: ConversationSessionRow): ConversationSession {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    startedAt: row.started_at,
    lastMessageAt: row.last_message_at,
    closedAt: row.closed_at,
    summary: row.summary,
    context: row.context_json ? (JSON.parse(row.context_json) as Record<string, unknown>) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPendingAction(row: PendingActionRow): PendingAction {
  return {
    id: row.id,
    userId: row.user_id,
    conversationSessionId: row.conversation_session_id,
    token: row.token,
    actionType: row.action_type,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    respondedAt: row.responded_at,
  };
}

function mapUserSetting(row: UserSettingRow): UserSetting {
  return {
    id: row.id,
    userId: row.user_id,
    key: row.key,
    value: JSON.parse(row.value_json) as unknown,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapUserMemory(row: UserMemoryRow): UserMemory {
  return {
    id: row.id,
    userId: row.user_id,
    key: row.key,
    value: JSON.parse(row.value_json) as unknown,
    category: row.category,
    importance: row.importance,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MemoryService {
  private readonly users: UserService;

  constructor(private readonly db: DB) {
    this.users = new UserService(db);
  }

  upsertUserSetting(userExternalId: string, key: string, value: unknown): UserSetting {
    const userId = this.users.ensureUser(userExternalId);
    const now = nowIso();

    this.db
      .prepare(
        `
          INSERT INTO user_settings (user_id, key, value_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(user_id, key)
          DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
        `,
      )
      .run(userId, key, JSON.stringify(value), now, now);

    const row = this.db
      .prepare("SELECT * FROM user_settings WHERE user_id = ? AND key = ?")
      .get(userId, key) as UserSettingRow;

    return mapUserSetting(row);
  }

  getUserSetting(userExternalId: string, key: string): UserSetting | null {
    const userId = this.users.ensureUser(userExternalId);
    const row = this.db
      .prepare("SELECT * FROM user_settings WHERE user_id = ? AND key = ?")
      .get(userId, key) as UserSettingRow | undefined;

    return row ? mapUserSetting(row) : null;
  }

  upsertUserMemory(
    userExternalId: string,
    key: string,
    value: unknown,
    options?: { category?: string; importance?: number },
  ): UserMemory {
    const userId = this.users.ensureUser(userExternalId);
    const now = nowIso();
    const category = options?.category ?? "fact";
    const importance = Math.min(10, Math.max(1, options?.importance ?? 5));

    this.db
      .prepare(
        `
          INSERT INTO user_memory (user_id, key, value_json, category, importance, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, key)
          DO UPDATE SET
            value_json = excluded.value_json,
            category = excluded.category,
            importance = excluded.importance,
            updated_at = excluded.updated_at
        `,
      )
      .run(userId, key, JSON.stringify(value), category, importance, now, now);

    const row = this.db
      .prepare("SELECT * FROM user_memory WHERE user_id = ? AND key = ?")
      .get(userId, key) as UserMemoryRow;

    return mapUserMemory(row);
  }

  listUserMemory(userExternalId: string, options?: { category?: string; limit?: number }): UserMemory[] {
    const userId = this.users.ensureUser(userExternalId);
    const limit = options?.limit ?? 100;

    if (options?.category) {
      const rows = this.db
        .prepare(
          `
            SELECT * FROM user_memory
            WHERE user_id = ? AND category = ?
            ORDER BY importance DESC, updated_at DESC
            LIMIT ?
          `,
        )
        .all(userId, options.category, limit) as UserMemoryRow[];

      return rows.map(mapUserMemory);
    }

    const rows = this.db
      .prepare(
        `
          SELECT * FROM user_memory
          WHERE user_id = ?
          ORDER BY importance DESC, updated_at DESC
          LIMIT ?
        `,
      )
      .all(userId, limit) as UserMemoryRow[];

    return rows.map(mapUserMemory);
  }

  getOrStartConversationSession(
    userExternalId: string,
    options?: { idleTimeoutMinutes?: number; now?: string },
  ): ConversationSession {
    const userId = this.users.ensureUser(userExternalId);
    const now = options?.now ?? nowIso();
    const idleTimeoutMinutes = options?.idleTimeoutMinutes ?? 60;

    const active = this.db
      .prepare(
        `
          SELECT * FROM conversation_sessions
          WHERE user_id = ? AND status = 'active'
          ORDER BY last_message_at DESC
          LIMIT 1
        `,
      )
      .get(userId) as ConversationSessionRow | undefined;

    if (!active) {
      return this.startConversationSession(userId, now);
    }

    const lastMessageAtMs = Date.parse(active.last_message_at);
    const nowMs = Date.parse(now);
    const idleMs = idleTimeoutMinutes * 60 * 1000;

    if (!Number.isFinite(lastMessageAtMs) || !Number.isFinite(nowMs) || nowMs - lastMessageAtMs <= idleMs) {
      return mapConversation(active);
    }

    this.db
      .prepare(
        `
          UPDATE conversation_sessions
          SET status = 'closed',
              closed_at = ?,
              updated_at = ?
          WHERE id = ?
        `,
      )
      .run(now, now, active.id);

    return this.startConversationSession(userId, now);
  }

  touchConversationSession(sessionId: number, now = nowIso()): ConversationSession {
    this.db
      .prepare(
        `
          UPDATE conversation_sessions
          SET last_message_at = ?,
              updated_at = ?
          WHERE id = ?
        `,
      )
      .run(now, now, sessionId);

    const row = this.db
      .prepare("SELECT * FROM conversation_sessions WHERE id = ?")
      .get(sessionId) as ConversationSessionRow | undefined;

    if (!row) throw new Error(`Conversation session ${sessionId} not found`);
    return mapConversation(row);
  }

  closeConversationSession(sessionId: number, summary?: string): ConversationSession {
    const now = nowIso();

    this.db
      .prepare(
        `
          UPDATE conversation_sessions
          SET status = 'closed',
              closed_at = ?,
              summary = COALESCE(?, summary),
              updated_at = ?
          WHERE id = ?
        `,
      )
      .run(now, summary ?? null, now, sessionId);

    const row = this.db
      .prepare("SELECT * FROM conversation_sessions WHERE id = ?")
      .get(sessionId) as ConversationSessionRow | undefined;

    if (!row) throw new Error(`Conversation session ${sessionId} not found`);
    return mapConversation(row);
  }

  createPendingAction(input: {
    userExternalId: string;
    actionType: string;
    payload: Record<string, unknown>;
    conversationSessionId?: number;
    ttlMinutes?: number;
    token?: string;
  }): PendingAction {
    const userId = this.users.ensureUser(input.userExternalId);
    const now = nowIso();
    const ttlMinutes = input.ttlMinutes ?? 15;
    const expiresAt = new Date(Date.parse(now) + ttlMinutes * 60 * 1000).toISOString();
    const token = input.token ?? randomUUID();

    this.db
      .prepare(
        `
          INSERT INTO pending_actions (
            user_id,
            conversation_session_id,
            token,
            action_type,
            payload_json,
            status,
            expires_at,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        `,
      )
      .run(
        userId,
        input.conversationSessionId ?? null,
        token,
        input.actionType,
        JSON.stringify(input.payload),
        expiresAt,
        now,
        now,
      );

    const row = this.db
      .prepare("SELECT * FROM pending_actions WHERE token = ?")
      .get(token) as PendingActionRow;

    return mapPendingAction(row);
  }

  getPendingActionByToken(token: string): PendingAction | null {
    const row = this.db
      .prepare("SELECT * FROM pending_actions WHERE token = ?")
      .get(token) as PendingActionRow | undefined;

    return row ? mapPendingAction(row) : null;
  }

  getLatestPendingActionForUser(userExternalId: string): PendingAction | null {
    const userId = this.users.ensureUser(userExternalId);
    const row = this.db
      .prepare(
        `
          SELECT * FROM pending_actions
          WHERE user_id = ? AND status = 'pending'
          ORDER BY created_at DESC
          LIMIT 1
        `,
      )
      .get(userId) as PendingActionRow | undefined;

    if (!row) return null;
    if (Date.parse(row.expires_at) < Date.now()) {
      this.updatePendingActionStatus(row.token, "expired");
      return null;
    }

    return mapPendingAction(row);
  }

  updatePendingActionStatus(token: string, status: PendingActionStatus): PendingAction {
    const now = nowIso();
    const respondedAt = status === "confirmed" || status === "cancelled" || status === "executed" ? now : null;

    const result = this.db
      .prepare(
        `
          UPDATE pending_actions
          SET status = ?,
              responded_at = COALESCE(?, responded_at),
              updated_at = ?
          WHERE token = ?
        `,
      )
      .run(status, respondedAt, now, token);

    if (result.changes === 0) throw new Error(`Pending action token not found: ${token}`);

    const row = this.db
      .prepare("SELECT * FROM pending_actions WHERE token = ?")
      .get(token) as PendingActionRow;

    return mapPendingAction(row);
  }

  expireStalePendingActions(now = nowIso()): number {
    const result = this.db
      .prepare(
        `
          UPDATE pending_actions
          SET status = 'expired',
              updated_at = ?
          WHERE status = 'pending' AND expires_at < ?
        `,
      )
      .run(now, now);

    return result.changes;
  }

  private startConversationSession(userId: number, now: string): ConversationSession {
    const info = this.db
      .prepare(
        `
          INSERT INTO conversation_sessions (
            user_id,
            status,
            started_at,
            last_message_at,
            created_at,
            updated_at
          )
          VALUES (?, 'active', ?, ?, ?, ?)
        `,
      )
      .run(userId, now, now, now, now);

    const row = this.db
      .prepare("SELECT * FROM conversation_sessions WHERE id = ?")
      .get(info.lastInsertRowid) as ConversationSessionRow;

    return mapConversation(row);
  }
}
