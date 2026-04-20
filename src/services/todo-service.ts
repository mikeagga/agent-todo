import type { DB } from "../db/client.js";
import type { Todo } from "../models.js";
import {
  AddTodoInputSchema,
  CompleteTodoInputSchema,
  UpdateTodoInputSchema,
  CancelTodoInputSchema,
  ListTodosInputSchema,
  SearchTodosInputSchema,
  type AddTodoInput,
  type CompleteTodoInput,
  type UpdateTodoInput,
  type CancelTodoInput,
  type ListTodosInput,
  type SearchTodosInput,
} from "../protocol/contracts.js";
import { UserService } from "./user-service.js";
import { nowIso } from "../time/protocol.js";

interface TodoRow {
  id: number;
  user_id: number;
  title: string;
  notes: string | null;
  due_at: string | null;
  priority: Todo["priority"];
  status: Todo["status"];
  source: string;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function cancelPendingRemindersForTodo(db: DB, todoId: number, now: string): number {
  const result = db
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

function mapTodo(row: TodoRow): Todo {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    notes: row.notes,
    dueAt: row.due_at,
    priority: row.priority,
    status: row.status,
    source: row.source,
    metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export class TodoService {
  private readonly users: UserService;

  constructor(private readonly db: DB) {
    this.users = new UserService(db);
  }

  addTodo(input: AddTodoInput): Todo {
    const parsed = AddTodoInputSchema.parse(input);
    const userId = this.users.ensureUser(parsed.userExternalId);
    const metadata = parsed.metadata ? JSON.stringify(parsed.metadata) : null;

    const stmt = this.db.prepare(`
      INSERT INTO todos (user_id, title, notes, due_at, priority, source, metadata_json)
      VALUES (@user_id, @title, @notes, @due_at, @priority, @source, @metadata_json)
    `);

    const info = stmt.run({
      user_id: userId,
      title: parsed.title,
      notes: parsed.notes ?? null,
      due_at: parsed.dueAt ?? null,
      priority: parsed.priority,
      source: parsed.source,
      metadata_json: metadata,
    });

    const row = this.db
      .prepare("SELECT * FROM todos WHERE id = ?")
      .get(info.lastInsertRowid) as TodoRow;

    return mapTodo(row);
  }

  updateTodo(input: UpdateTodoInput): Todo {
    const parsed = UpdateTodoInputSchema.parse(input);
    const userId = this.users.getUserIdOrThrow(parsed.userExternalId);

    const now = nowIso();
    const sets: string[] = ["updated_at = @updated_at"];
    const params: Record<string, unknown> = {
      updated_at: now,
      todo_id: parsed.todoId,
      user_id: userId,
    };

    if (parsed.title !== undefined) {
      sets.push("title = @title");
      params.title = parsed.title;
    }

    if (parsed.priority !== undefined) {
      sets.push("priority = @priority");
      params.priority = parsed.priority;
    }

    if (parsed.clearNotes) {
      sets.push("notes = NULL");
    } else if (parsed.notes !== undefined) {
      sets.push("notes = @notes");
      params.notes = parsed.notes;
    }

    if (parsed.clearDueAt) {
      sets.push("due_at = NULL");
    } else if (parsed.dueAt !== undefined) {
      sets.push("due_at = @due_at");
      params.due_at = parsed.dueAt;
    }

    const updated = this.db
      .prepare(
        `
          UPDATE todos
          SET ${sets.join(", ")}
          WHERE id = @todo_id AND user_id = @user_id
        `,
      )
      .run(params);

    if (updated.changes === 0) {
      throw new Error(`Todo ${parsed.todoId} not found for user ${parsed.userExternalId}`);
    }

    const row = this.db
      .prepare("SELECT * FROM todos WHERE id = ?")
      .get(parsed.todoId) as TodoRow;

    return mapTodo(row);
  }

  completeTodo(input: CompleteTodoInput): Todo {
    const parsed = CompleteTodoInputSchema.parse(input);
    const userId = this.users.getUserIdOrThrow(parsed.userExternalId);

    const now = nowIso();
    const updated = this.db
      .prepare(`
        UPDATE todos
        SET status = 'done',
            completed_at = ?,
            updated_at = ?
        WHERE id = ? AND user_id = ?
      `)
      .run(now, now, parsed.todoId, userId);

    if (updated.changes > 0) {
      cancelPendingRemindersForTodo(this.db, parsed.todoId, now);
    }

    if (updated.changes === 0) {
      throw new Error(`Todo ${parsed.todoId} not found for user ${parsed.userExternalId}`);
    }

    const row = this.db
      .prepare("SELECT * FROM todos WHERE id = ?")
      .get(parsed.todoId) as TodoRow;

    return mapTodo(row);
  }

  cancelTodo(input: CancelTodoInput): Todo {
    const parsed = CancelTodoInputSchema.parse(input);
    const userId = this.users.getUserIdOrThrow(parsed.userExternalId);

    const now = nowIso();
    const updated = this.db
      .prepare(`
        UPDATE todos
        SET status = 'cancelled',
            completed_at = NULL,
            updated_at = ?
        WHERE id = ? AND user_id = ?
      `)
      .run(now, parsed.todoId, userId);

    if (updated.changes > 0) {
      cancelPendingRemindersForTodo(this.db, parsed.todoId, now);
    }

    if (updated.changes === 0) {
      throw new Error(`Todo ${parsed.todoId} not found for user ${parsed.userExternalId}`);
    }

    const row = this.db
      .prepare("SELECT * FROM todos WHERE id = ?")
      .get(parsed.todoId) as TodoRow;

    return mapTodo(row);
  }

  listTodos(input: ListTodosInput): Todo[] {
    const parsed = ListTodosInputSchema.parse(input);

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

    if (parsed.dueBefore) {
      where.push("(due_at IS NOT NULL AND due_at <= @due_before)");
      params.due_before = parsed.dueBefore;
    }

    const sql = `
      SELECT * FROM todos
      WHERE ${where.join(" AND ")}
      ORDER BY
        CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,
        due_at ASC,
        id DESC
      LIMIT @limit
    `;

    const rows = this.db.prepare(sql).all(params) as TodoRow[];
    return rows.map(mapTodo);
  }

  searchTodos(input: SearchTodosInput): Todo[] {
    const parsed = SearchTodosInputSchema.parse(input);

    const userId = this.users.getUserIdOrNull(parsed.userExternalId);
    if (userId === null) return [];

    const where: string[] = ["user_id = @user_id"];
    const params: Record<string, unknown> = {
      user_id: userId,
      limit: parsed.limit,
    };

    if (!parsed.includeDone) {
      where.push("status != 'done'");
    }

    if (!parsed.includeCancelled) {
      where.push("status != 'cancelled'");
    }

    const query = (parsed.query ?? "").trim().toLowerCase();
    if (query) {
      where.push("(LOWER(title) LIKE @query OR LOWER(COALESCE(notes, '')) LIKE @query)");
      params.query = `%${query}%`;
    }

    if (parsed.olderThanDays && parsed.olderThanDays > 0) {
      const olderThanMs = Date.now() - parsed.olderThanDays * 24 * 60 * 60 * 1000;
      params.older_than = new Date(olderThanMs).toISOString();
      where.push("created_at <= @older_than");
    }

    let orderBy = "updated_at DESC, id DESC";
    if (parsed.sort === "oldest") {
      orderBy = "created_at ASC, id ASC";
    } else if (parsed.sort === "due") {
      orderBy = "CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, id DESC";
    }

    const sql = `
      SELECT * FROM todos
      WHERE ${where.join(" AND ")}
      ORDER BY ${orderBy}
      LIMIT @limit
    `;

    const rows = this.db.prepare(sql).all(params) as TodoRow[];
    return rows.map(mapTodo);
  }

  getTodoById(userExternalId: string, todoId: number): Todo | null {
    const userId = this.users.getUserIdOrNull(userExternalId);
    if (userId === null) return null;

    const row = this.db
      .prepare("SELECT * FROM todos WHERE id = ? AND user_id = ?")
      .get(todoId, userId) as TodoRow | undefined;

    return row ? mapTodo(row) : null;
  }
}
