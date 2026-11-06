/** Notifications are a to-do list: each one stays until the user acts on it. */
import { type DB, type Row, transaction } from "../db/db.ts";
import { uuidv7 } from "../lib/ids.ts";
import { badRequest, conflict, notFound } from "../lib/http.ts";
import * as v from "../lib/validate.ts";
import { enqueue } from "./channels.ts";

export type Resolution = "adjusted" | "sold" | "dismissed" | "reviewed" | "updated";

export interface NewNotification {
  kind: "trigger_fired" | "claim_review_due" | "balance_update_due";
  title: string;
  body: string;
  refType: "trigger" | "claim" | "account";
  refId: string;
}

export function createNotification(db: DB, n: NewNotification): string {
  const id = uuidv7();
  db.prepare(
    `INSERT INTO notifications(id, kind, title, body, ref_type, ref_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
  ).run(id, n.kind, n.title, n.body, n.refType, n.refId, Date.now());
  enqueue(db, id); // outbound channels (sent by the background dispatcher)
  return id;
}

export function hasOpenNotification(db: DB, kind: string, refType: string, refId: string): boolean {
  return !!db.prepare(
    "SELECT 1 FROM notifications WHERE kind = ? AND ref_type = ? AND ref_id = ? AND status <> 'resolved'",
  ).get(kind, refType, refId);
}

export function getNotification(db: DB, id: string): Row {
  const r = db.prepare("SELECT * FROM notifications WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw notFound("Notification not found");
  return r;
}

function enrich(db: DB, n: Row): Row {
  if (n.kind === "trigger_fired") {
    const f = db.prepare(
      `SELECT f.*, l.asset_id, l.buy_trade_id, l.thesis_id, t.title AS thesis_title, a.name AS asset_name,
              g.type AS trigger_type, g.params AS trigger_params, g.label AS trigger_label
       FROM trigger_firings f
       JOIN thesis_links l ON l.id = f.link_id
       JOIN theses t ON t.id = l.thesis_id
       JOIN assets a ON a.id = l.asset_id
       JOIN triggers g ON g.id = f.trigger_id
       WHERE f.notification_id = ?`,
    ).get(n.id as string) as Row | undefined;
    if (f) {
      return {
        ...n,
        firing: {
          ...f,
          observed: JSON.parse(f.observed as string),
          trigger_params: JSON.parse(f.trigger_params as string),
        },
      };
    }
  }
  if (n.kind === "claim_review_due") {
    const c = db.prepare("SELECT * FROM claims WHERE id = ?").get(n.ref_id as string);
    if (c) {
      const theses = db.prepare(
        `SELECT t.id, t.title FROM thesis_claims tc JOIN theses t ON t.id = tc.thesis_id
         WHERE tc.claim_id = ? AND tc.detached_at IS NULL ORDER BY t.title`,
      ).all(n.ref_id as string);
      return { ...n, claim: { ...c, theses } };
    }
  }
  if (n.kind === "balance_update_due") {
    const a = db.prepare("SELECT id, name, kind, currency FROM accounts WHERE id = ?").get(
      n.ref_id as string,
    );
    if (a) return { ...n, account: a };
  }
  return n;
}

/** Open items plus snoozed ones whose snooze has ended. */
export function listActionable(db: DB, todayStr: string): Row[] {
  return db.prepare(
    `SELECT * FROM notifications
     WHERE status = 'open' OR (status = 'snoozed' AND snoozed_until <= ?)
     ORDER BY created_at`,
  ).all(todayStr).map((n) => enrich(db, n));
}

export function listAll(db: DB, status?: string, limit = 200): Row[] {
  return db.prepare(
    `SELECT * FROM notifications ${status ? "WHERE status = ?" : ""} ORDER BY created_at DESC LIMIT ?`,
  ).all(...(status ? [status, limit] : [limit])).map((n) => enrich(db, n));
}

export function countActionable(db: DB, todayStr: string): number {
  const r = db.prepare(
    "SELECT count(*) AS n FROM notifications WHERE status = 'open' OR (status = 'snoozed' AND snoozed_until <= ?)",
  ).get(todayStr) as Row;
  return Number(r.n);
}

/** User action on a notification: snooze, dismiss (reason required), or mark sold. */
export function actOn(db: DB, id: string, body: Record<string, unknown>, todayStr: string): Row {
  const n = getNotification(db, id);
  if (n.status === "resolved") throw conflict("Already resolved");
  const action = v.oneOf(body, "action", ["snooze", "dismiss", "sold", "updated"] as const)!;
  return transaction(db, () => {
    if (action === "snooze") {
      const until = v.date(body, "until")!;
      if (until <= todayStr) throw badRequest("Snooze until a future date");
      db.prepare("UPDATE notifications SET status = 'snoozed', snoozed_until = ? WHERE id = ?").run(
        until,
        id,
      );
    } else {
      const note = action === "dismiss"
        ? v.reqStr(body, "note", { max: 2000 }) // dismissing needs a reason
        : v.str(body, "note", { optional: true, max: 2000 }) ?? "";
      const resolution: Resolution = action === "dismiss" ? "dismissed" : action;
      if (n.kind === "trigger_fired") closeFirings(db, { notificationId: id }, resolution, note);
      else resolve(db, id, resolution, note);
    }
    return enrich(db, getNotification(db, id));
  });
}

function resolve(db: DB, id: string, resolution: Resolution, note: string) {
  db.prepare(
    `UPDATE notifications SET status = 'resolved', resolution = ?, resolution_note = ?, resolved_at = ?
     WHERE id = ? AND status <> 'resolved'`,
  ).run(resolution, note, Date.now(), id);
}

/**
 * Close open trigger firings (by trigger, link or notification), resolve their notifications, and move a
 * 'triggered' thesis back to 'active' once nothing is outstanding.
 */
export function closeFirings(
  db: DB,
  where: { triggerId?: string; thesisId?: string; linkId?: string; notificationId?: string },
  resolution: Resolution,
  note: string,
): void {
  // Any combination of filters; at least one is required.
  const conds: string[] = [];
  const vals: string[] = [];
  if (where.triggerId) conds.push("f.trigger_id = ?"), vals.push(where.triggerId);
  if (where.thesisId) conds.push("l.thesis_id = ?"), vals.push(where.thesisId);
  if (where.linkId) conds.push("f.link_id = ?"), vals.push(where.linkId);
  if (where.notificationId) conds.push("f.notification_id = ?"), vals.push(where.notificationId);
  if (!conds.length) throw new Error("closeFirings needs a filter");
  const firings = db.prepare(
    `SELECT f.id, f.notification_id, l.thesis_id FROM trigger_firings f JOIN thesis_links l ON l.id = f.link_id
     WHERE ${conds.join(" AND ")} AND f.closed_at IS NULL`,
  ).all(...vals);
  const now = Date.now();
  const theses = new Set<string>();
  for (const f of firings) {
    db.prepare("UPDATE trigger_firings SET closed_at = ? WHERE id = ?").run(now, f.id as string);
    resolve(db, f.notification_id as string, resolution, note);
    theses.add(f.thesis_id as string);
  }
  for (const thesisId of theses) {
    const stillOpen = db.prepare(
      `SELECT 1 FROM trigger_firings f JOIN thesis_links l ON l.id = f.link_id
       WHERE l.thesis_id = ? AND f.closed_at IS NULL`,
    ).get(thesisId);
    if (!stillOpen) {
      db.prepare("UPDATE theses SET status = 'active', updated_at = ? WHERE id = ? AND status = 'triggered'")
        .run(now, thesisId);
    }
  }
}
