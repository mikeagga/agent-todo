import type { DB } from "../db/client.js";

export class UserService {
  constructor(private readonly db: DB) {}

  getUserIdOrNull(externalId: string): number | null {
    const row = this.db
      .prepare("SELECT id FROM users WHERE external_id = ?")
      .get(externalId) as { id: number } | undefined;

    return row?.id ?? null;
  }

  getUserIdOrThrow(externalId: string): number {
    const userId = this.getUserIdOrNull(externalId);
    if (userId === null) {
      throw new Error(`Unknown user external id: ${externalId}`);
    }
    return userId;
  }

  ensureUser(externalId: string, timezone = "UTC"): number {
    const existingId = this.getUserIdOrNull(externalId);
    if (existingId !== null) return existingId;

    const insertStmt = this.db.prepare("INSERT INTO users (external_id, timezone) VALUES (?, ?)");
    const info = insertStmt.run(externalId, timezone);

    return Number(info.lastInsertRowid);
  }
}
