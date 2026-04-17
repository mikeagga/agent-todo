PRAGMA foreign_keys = ON;

ALTER TABLE reminders ADD COLUMN todo_id INTEGER REFERENCES todos(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_reminders_todo_id ON reminders(todo_id);
