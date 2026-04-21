import fs from "node:fs";
import path from "node:path";
import type { DB } from "./client.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "src", "db", "migrations");

export function runMigrations(db: DB): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);

  const existing = new Set(
    db
      .prepare("SELECT filename FROM schema_migrations ORDER BY id")
      .all()
      .map((row) => (row as { filename: string }).filename),
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied: string[] = [];
  const insertApplied = db.prepare("INSERT INTO schema_migrations (filename) VALUES (?)");

  const tx = db.transaction((filename: string, sql: string) => {
    db.exec(sql);
    insertApplied.run(filename);
  });

  for (const file of files) {
    if (existing.has(file)) continue;

    const fullPath = path.join(MIGRATIONS_DIR, file);
    const sql = fs.readFileSync(fullPath, "utf8");

    tx(file, sql);
    applied.push(file);
  }

  return applied;
}
