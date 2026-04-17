import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type DB = Database.Database;

export interface DatabaseOptions {
  filePath?: string;
  readonly?: boolean;
}

export function createDatabase(options: DatabaseOptions = {}): DB {
  const filePath = options.filePath ?? path.resolve(process.cwd(), "data", "todo-reminders.db");
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(filePath, {
    readonly: options.readonly ?? false,
    fileMustExist: options.readonly ?? false,
    timeout: 5000,
  });

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  return db;
}
