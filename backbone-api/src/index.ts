import path from "node:path";
import { createDatabase, type DatabaseOptions } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { ReminderService } from "./services/reminder-service.js";
import { TodoService } from "./services/todo-service.js";
import { MemoryService } from "./services/memory-service.js";

export interface Backbone {
  dbPath: string;
  db: ReturnType<typeof createDatabase>;
  todoService: TodoService;
  reminderService: ReminderService;
  memoryService: MemoryService;
  close: () => void;
}

export function createBackbone(options: DatabaseOptions = {}): Backbone {
  const dbPath = options.filePath ?? path.resolve(process.cwd(), "data", "todo-reminders.db");
  const db = createDatabase({ ...options, filePath: dbPath });
  runMigrations(db);

  const todoService = new TodoService(db);
  const reminderService = new ReminderService(db);
  const memoryService = new MemoryService(db);

  return {
    dbPath,
    db,
    todoService,
    reminderService,
    memoryService,
    close: () => db.close(),
  };
}

export * from "./models.js";
export * from "./protocol/contracts.js";
