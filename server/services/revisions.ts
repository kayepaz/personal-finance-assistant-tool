import type { DB, Row } from "../db/db.ts";
import { uuidv7 } from "../lib/ids.ts";

export type EntityType = "thesis" | "thesis_link" | "claim" | "trigger" | "thesis_claim" | "thesis_trigger";
export type RevisionAction = "create" | "update" | "retire" | "unlink" | "attach" | "detach";

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

/** Bookkeeping fields that change on every edit and would only add noise to a change list. */
const IGNORED = new Set(["id", "updated_at"]);

export interface FieldChange {
  field: string;
  before: unknown; // undefined on create
  after: unknown;
}

/** Fields that differ between two snapshots (all non-empty fields when there is no previous snapshot). */
export function diffSnapshots(before: Row | undefined, after: Row): FieldChange[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);
  const out: FieldChange[] = [];
  for (const k of keys) {
    if (IGNORED.has(k)) continue;
    const a = before?.[k], b = after[k];
    if (!before) {
      if (b === null || b === undefined || b === "") continue;
      out.push({ field: k, before: undefined, after: b });
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push({ field: k, before: a ?? null, after: b ?? null });
    }
  }
  return out;
}

/** Newest first; each revision carries the fields it changed compared with the revision before it. */
export function listRevisions(db: DB, entityType: EntityType, entityId: string): Row[] {
  const rows = db.prepare(
    `SELECT revision_no, action, data, note, created_at FROM revisions
     WHERE entity_type = ? AND entity_id = ? ORDER BY revision_no ASC`,
  ).all(entityType, entityId).map((r) => ({ ...r, data: JSON.parse(r.data as string) as Row }));
  return rows.map((r, i) => ({ ...r, changes: diffSnapshots(i ? rows[i - 1].data : undefined, r.data) }))
    .reverse();
}
