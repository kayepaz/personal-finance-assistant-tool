import type { DB, Row } from "../db/db.ts";
import { uuidv7 } from "../lib/ids.ts";

export type EntityType = "thesis" | "thesis_link" | "claim" | "trigger";
export type RevisionAction = "create" | "update" | "retire" | "unlink";

/** Append a full snapshot of an entity. Call inside the same transaction as the change. */
export function recordRevision(
  db: DB,
  entityType: EntityType,
  entityId: string,
  action: RevisionAction,
  data: Row,
  note = "",
): void {
  const last = db.prepare(
    "SELECT max(revision_no) AS n FROM revisions WHERE entity_type = ? AND entity_id = ?",
  ).get(entityType, entityId) as Row;
  const next = Number(last.n ?? 0) + 1;
  db.prepare(
    `INSERT INTO revisions(id, entity_type, entity_id, revision_no, action, data, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(uuidv7(), entityType, entityId, next, action, JSON.stringify(data), note, Date.now());
}

export function listRevisions(db: DB, entityType: EntityType, entityId: string): Row[] {
  return db.prepare(
    `SELECT revision_no, action, data, note, created_at FROM revisions
     WHERE entity_type = ? AND entity_id = ? ORDER BY revision_no DESC`,
  ).all(entityType, entityId).map((r) => ({ ...r, data: JSON.parse(r.data as string) }));
}
