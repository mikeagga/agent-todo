import path from "node:path";
import { createDatabase } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";

const dbPath = process.env.DB_PATH ?? path.resolve(process.cwd(), "data", "todo-reminders.db");
const db = createDatabase({ filePath: dbPath });

try {
  const applied = runMigrations(db);
  if (applied.length === 0) {
    console.log(`Database ready: ${dbPath} (no new migrations)`);
  } else {
    console.log(`Database ready: ${dbPath}`);
    console.log(`Applied migrations: ${applied.join(", ")}`);
  }
} finally {
  db.close();
}
