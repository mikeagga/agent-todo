PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS reminder_dispatch_receipts (
  reminder_id INTEGER PRIMARY KEY,
  claim_token TEXT,
  claimed_at TEXT NOT NULL,
  sent_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (reminder_id) REFERENCES reminders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reminder_dispatch_receipts_sent_claimed
  ON reminder_dispatch_receipts(sent_at, claimed_at);
