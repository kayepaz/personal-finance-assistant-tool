/** Triggers are a shared library: one rule, attachable to many theses, evaluated per linked holding. */
import { type DB, type Row, transaction } from "../db/db.ts";
import { uuidv7 } from "../lib/ids.ts";
import { badRequest, conflict, notFound } from "../lib/http.ts";
import * as v from "../lib/validate.ts";
import { listRevisions, recordRevision } from "./revisions.ts";
import { closeFirings } from "./notifications.ts";

type Obj = Record<string, unknown>;

export const TRIGGER_TYPES = ["sell_on_date", "sell_after_days", "pct_change"] as const;

export interface PctParams {
  direction: "up" | "down";
  percent: string;
  baseline: "avg_cost" | "purchase_price" | "fixed";
  fixed_price?: string;
}
export interface DateParams {
  date: string;
}
export interface AfterDaysParams {
  days: number;
  from: "purchase" | "trigger_created";
}

const note = (body: Obj) => v.str(body, "note", { optional: true, max: 2000 }) ?? "";

export function validateTriggerParams(type: string, p: unknown): Row {
  if (typeof p !== "object" || p === null || Array.isArray(p)) throw badRequest("'params' must be an object");
  const o = p as Obj;
  switch (type) {
    case "sell_on_date":
      return { date: v.date(o, "date")! };
    case "sell_after_days":
      return {
        days: v.int(o, "days", { min: 1, max: 36_500 })!,
        from: v.oneOf(o, "from", ["purchase", "trigger_created"] as const, { optional: true }) ?? "purchase",
      };
    case "pct_change": {
      const baseline =
        v.oneOf(o, "baseline", ["avg_cost", "purchase_price", "fixed"] as const, { optional: true }) ??
          "avg_cost";
      const out: Row = {
        direction: v.oneOf(o, "direction", ["up", "down"] as const)!,
        percent: v.dec(o, "percent", { positive: true })!,
        baseline,
      };
      if (baseline === "fixed") out.fixed_price = v.dec(o, "fixed_price", { positive: true })!;
      return out;
    }
    default:
      throw badRequest(`Unknown trigger type '${type}'`);
  }
}

function raw(db: DB, id: string): Row {
  const r = db.prepare("SELECT * FROM triggers WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw notFound("Trigger not found");
  return { ...r, params: JSON.parse(r.params as string) };
}

export function thesesUsingTrigger(db: DB, triggerId: string): Row[] {
  return db.prepare(
    `SELECT t.id, t.title, t.status, tt.id AS attachment_id FROM thesis_triggers tt JOIN theses t ON t.id = tt.thesis_id
     WHERE tt.trigger_id = ? AND tt.detached_at IS NULL ORDER BY t.title`,
  ).all(triggerId);
}

export function getTrigger(db: DB, id: string): Row {
  return { ...raw(db, id), theses: thesesUsingTrigger(db, id), history: listRevisions(db, "trigger", id) };
}

export function listTriggers(db: DB, status?: string): Row[] {
  return db.prepare(
    `SELECT g.*, (SELECT count(*) FROM thesis_triggers tt WHERE tt.trigger_id = g.id AND tt.detached_at IS NULL) AS thesis_count
     FROM triggers g ${status ? "WHERE g.status = ?" : ""} ORDER BY g.status, g.label, g.created_at`,
  ).all(...(status ? [status] : [])).map((r) => ({ ...r, params: JSON.parse(r.params as string) }));
}

/** Create a trigger; optionally attach it to a thesis in the same step. */
export function createTrigger(db: DB, body: Obj): Row {
  const type = v.oneOf(body, "type", TRIGGER_TYPES)!;
  const params = validateTriggerParams(type, body.params);
  const thesisId = v.str(body, "thesis_id", { optional: true }) || undefined;
  const id = uuidv7();
  const now = Date.now();
  return transaction(db, () => {
    db.prepare(
      `INSERT INTO triggers(id, type, params, label, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    ).run(
      id,
      type,
      JSON.stringify(params),
      v.str(body, "label", { optional: true, max: 200 }) ?? "",
      now,
      now,
    );
    recordRevision(db, "trigger", id, "create", raw(db, id), note(body));
    if (thesisId) attachTrigger(db, thesisId, { trigger_id: id });
    return getTrigger(db, id);
  });
}

/** Edits apply to every thesis using the trigger; open alerts resolve as 'adjusted' and the trigger re-arms. */
export function updateTrigger(db: DB, id: string, body: Obj): Row {
  const t = raw(db, id);
  if (t.status === "retired") throw conflict("This trigger is retired");
  const why = note(body);
  return transaction(db, () => {
    let action: "update" | "retire" = "update";
    if (v.has(body, "params")) {
      db.prepare("UPDATE triggers SET params = ? WHERE id = ?")
        .run(JSON.stringify(validateTriggerParams(t.type as string, body.params)), id);
    }
    if (v.has(body, "label")) {
      db.prepare("UPDATE triggers SET label = ? WHERE id = ?")
        .run(v.str(body, "label", { optional: true, max: 200 }) ?? "", id);
    }
    if (v.has(body, "status") && v.oneOf(body, "status", ["active", "retired"] as const) === "retired") {
      db.prepare("UPDATE triggers SET status = 'retired' WHERE id = ?").run(id);
      action = "retire";
    }
    db.prepare("UPDATE triggers SET updated_at = ? WHERE id = ?").run(Date.now(), id);
    closeFirings(
      db,
      { triggerId: id },
      "adjusted",
      why || (action === "retire" ? "Trigger removed" : "Trigger adjusted"),
    );
    recordRevision(db, "trigger", id, action, raw(db, id), why);
    return getTrigger(db, id);
  });
}

// ---------- attach / detach ----------

function touchThesis(db: DB, thesisId: string) {
  const r = db.prepare("UPDATE theses SET updated_at = ? WHERE id = ?").run(Date.now(), thesisId);
  if (r.changes === 0) throw notFound("Thesis not found");
}

export function attachTrigger(db: DB, thesisId: string, body: Obj): Row {
  const triggerId = v.reqStr(body, "trigger_id");
  const t = raw(db, triggerId);
  if (t.status === "retired") throw badRequest("That trigger is retired");
  return transaction(db, () => {
    touchThesis(db, thesisId);
    const existing = db.prepare(
      "SELECT * FROM thesis_triggers WHERE thesis_id = ? AND trigger_id = ? AND detached_at IS NULL",
    ).get(thesisId, triggerId) as Row | undefined;
    if (existing) return existing;
    const id = uuidv7();
    db.prepare("INSERT INTO thesis_triggers(id, thesis_id, trigger_id, attached_at) VALUES (?, ?, ?, ?)")
      .run(id, thesisId, triggerId, Date.now());
    const row = db.prepare("SELECT * FROM thesis_triggers WHERE id = ?").get(id) as Row;
    recordRevision(db, "thesis_trigger", id, "attach", row, note(body));
    return row;
  });
}

/** Removing a trigger from one thesis resolves that thesis's open alerts for it. */
export function detachTrigger(db: DB, attachmentId: string, body: Obj): void {
  const a = db.prepare("SELECT * FROM thesis_triggers WHERE id = ?").get(attachmentId) as Row | undefined;
  if (!a) throw notFound("Attachment not found");
  if (a.detached_at) return;
  const reason = v.reqStr(body, "reason", { max: 2000 });
  transaction(db, () => {
    db.prepare("UPDATE thesis_triggers SET detached_at = ?, detach_reason = ? WHERE id = ?")
      .run(Date.now(), reason, attachmentId);
    closeFirings(
      db,
      { triggerId: a.trigger_id as string, thesisId: a.thesis_id as string },
      "adjusted",
      `Removed from thesis: ${reason}`,
    );
    recordRevision(
      db,
      "thesis_trigger",
      attachmentId,
      "detach",
      db.prepare("SELECT * FROM thesis_triggers WHERE id = ?").get(attachmentId) as Row,
      reason,
    );
    touchThesis(db, a.thesis_id as string);
  });
}

export function triggersForThesis(db: DB, thesisId: string): Row[] {
  return db.prepare(
    `SELECT g.*, tt.id AS attachment_id, tt.attached_at,
       (SELECT count(*) FROM thesis_triggers o WHERE o.trigger_id = g.id AND o.detached_at IS NULL) AS thesis_count
     FROM thesis_triggers tt JOIN triggers g ON g.id = tt.trigger_id
     WHERE tt.thesis_id = ? AND tt.detached_at IS NULL ORDER BY g.status, tt.attached_at`,
  ).all(thesisId).map((r) => ({ ...r, params: JSON.parse(r.params as string) }));
}
