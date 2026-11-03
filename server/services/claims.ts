/** Claims are a shared library: one statement, one review schedule, attachable to many theses. */
import { type DB, type Row, transaction } from "../db/db.ts";
import { uuidv7 } from "../lib/ids.ts";
import { badRequest, notFound } from "../lib/http.ts";
import { addDays } from "../lib/dates.ts";
import * as v from "../lib/validate.ts";
import { listRevisions, recordRevision } from "./revisions.ts";

type Obj = Record<string, unknown>;

export const VERDICTS = ["still_true", "weakened", "no_longer_true"] as const;

const note = (body: Obj) => v.str(body, "note", { optional: true, max: 2000 }) ?? "";

function raw(db: DB, id: string): Row {
  const r = db.prepare("SELECT * FROM claims WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw notFound("Claim not found");
  return r;
}

export function thesesUsingClaim(db: DB, claimId: string): Row[] {
  return db.prepare(
    `SELECT t.id, t.title, t.status, tc.id AS attachment_id FROM thesis_claims tc JOIN theses t ON t.id = tc.thesis_id
     WHERE tc.claim_id = ? AND tc.detached_at IS NULL ORDER BY t.title`,
  ).all(claimId);
}

export function getClaim(db: DB, id: string): Row {
  return {
    ...raw(db, id),
    theses: thesesUsingClaim(db, id),
    reviews: listClaimReviews(db, id),
    history: listRevisions(db, "claim", id),
  };
}

export function listClaims(db: DB, status?: string): Row[] {
  return db.prepare(
    `SELECT c.*, (SELECT count(*) FROM thesis_claims tc WHERE tc.claim_id = c.id AND tc.detached_at IS NULL) AS thesis_count,
       (SELECT verdict FROM claim_reviews r WHERE r.claim_id = c.id ORDER BY reviewed_at DESC LIMIT 1) AS last_verdict
     FROM claims c ${status ? "WHERE c.status = ?" : ""} ORDER BY c.status, c.statement`,
  ).all(...(status ? [status] : []));
}

/** Create a claim; optionally attach it to a thesis in the same step. */
export function createClaim(db: DB, body: Obj, todayStr: string): Row {
  const every = v.int(body, "review_every_days", { min: 1, max: 3650 })!;
  const thesisId = v.str(body, "thesis_id", { optional: true }) || undefined;
  const id = uuidv7();
  const now = Date.now();
  return transaction(db, () => {
    db.prepare(
      `INSERT INTO claims(id, statement, review_every_days, next_review_on, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    ).run(id, v.reqStr(body, "statement", { max: 2000 }), every, addDays(todayStr, every), now, now);
    recordRevision(db, "claim", id, "create", raw(db, id), note(body));
    if (thesisId) attachClaim(db, thesisId, { claim_id: id });
    return getClaim(db, id);
  });
}

/** Edits apply everywhere the claim is used. Retiring resolves its open review. */
export function updateClaim(db: DB, id: string, body: Obj, todayStr: string): Row {
  raw(db, id);
  return transaction(db, () => {
    if (v.has(body, "statement")) {
      db.prepare("UPDATE claims SET statement = ? WHERE id = ?").run(
        v.reqStr(body, "statement", { max: 2000 }),
        id,
      );
    }
    if (v.has(body, "review_every_days")) {
      const every = v.int(body, "review_every_days", { min: 1, max: 3650 })!;
      db.prepare("UPDATE claims SET review_every_days = ?, next_review_on = ? WHERE id = ?")
        .run(every, addDays(todayStr, every), id);
    }
    let action: "update" | "retire" = "update";
    if (v.has(body, "status")) {
      const s = v.oneOf(body, "status", ["active", "retired"] as const)!;
      db.prepare("UPDATE claims SET status = ? WHERE id = ?").run(s, id);
      if (s === "retired") {
        action = "retire";
        resolveClaimNotifications(db, id, "adjusted", note(body) || "Claim retired");
      }
    }
    db.prepare("UPDATE claims SET updated_at = ? WHERE id = ?").run(Date.now(), id);
    recordRevision(db, "claim", id, action, raw(db, id), note(body));
    return getClaim(db, id);
  });
}

/** One review covers every thesis that uses the claim. */
export function reviewClaim(db: DB, id: string, body: Obj, todayStr: string): Row {
  const c = raw(db, id);
  const verdict = v.oneOf(body, "verdict", VERDICTS)!;
  const reviewNote = v.str(body, "note", { optional: true, max: 5000 }) ?? "";
  return transaction(db, () => {
    db.prepare("INSERT INTO claim_reviews(id, claim_id, verdict, note, reviewed_at) VALUES (?, ?, ?, ?, ?)")
      .run(uuidv7(), id, verdict, reviewNote, Date.now());
    db.prepare("UPDATE claims SET next_review_on = ?, updated_at = ? WHERE id = ?")
      .run(addDays(todayStr, c.review_every_days as number), Date.now(), id);
    resolveClaimNotifications(db, id, "reviewed", `${verdict}${reviewNote ? `: ${reviewNote}` : ""}`);
    return getClaim(db, id);
  });
}

export function listClaimReviews(db: DB, claimId: string): Row[] {
  return db.prepare("SELECT * FROM claim_reviews WHERE claim_id = ? ORDER BY reviewed_at DESC").all(claimId);
}

function resolveClaimNotifications(db: DB, claimId: string, resolution: string, resolutionNote: string) {
  db.prepare(
    `UPDATE notifications SET status = 'resolved', resolution = ?, resolution_note = ?, resolved_at = ?
     WHERE ref_type = 'claim' AND ref_id = ? AND status <> 'resolved'`,
  ).run(resolution, resolutionNote, Date.now(), claimId);
}

// ---------- attach / detach ----------

function touchThesis(db: DB, thesisId: string) {
  const r = db.prepare("UPDATE theses SET updated_at = ? WHERE id = ?").run(Date.now(), thesisId);
  if (r.changes === 0) throw notFound("Thesis not found");
}

export function attachClaim(db: DB, thesisId: string, body: Obj): Row {
  const claimId = v.reqStr(body, "claim_id");
  const c = raw(db, claimId);
  if (c.status === "retired") throw badRequest("That claim is retired");
  return transaction(db, () => {
    touchThesis(db, thesisId);
    const existing = db.prepare(
      "SELECT * FROM thesis_claims WHERE thesis_id = ? AND claim_id = ? AND detached_at IS NULL",
    ).get(thesisId, claimId) as Row | undefined;
    if (existing) return existing;
    const id = uuidv7();
    db.prepare("INSERT INTO thesis_claims(id, thesis_id, claim_id, attached_at) VALUES (?, ?, ?, ?)")
      .run(id, thesisId, claimId, Date.now());
    const row = db.prepare("SELECT * FROM thesis_claims WHERE id = ?").get(id) as Row;
    recordRevision(db, "thesis_claim", id, "attach", row, note(body));
    return row;
  });
}

export function detachClaim(db: DB, attachmentId: string, body: Obj): void {
  const a = db.prepare("SELECT * FROM thesis_claims WHERE id = ?").get(attachmentId) as Row | undefined;
  if (!a) throw notFound("Attachment not found");
  if (a.detached_at) return;
  const reason = v.reqStr(body, "reason", { max: 2000 });
  transaction(db, () => {
    db.prepare("UPDATE thesis_claims SET detached_at = ?, detach_reason = ? WHERE id = ?")
      .run(Date.now(), reason, attachmentId);
    recordRevision(
      db,
      "thesis_claim",
      attachmentId,
      "detach",
      db.prepare("SELECT * FROM thesis_claims WHERE id = ?").get(attachmentId) as Row,
      reason,
    );
    touchThesis(db, a.thesis_id as string);
  });
}

export function claimsForThesis(db: DB, thesisId: string): Row[] {
  return db.prepare(
    `SELECT c.*, tc.id AS attachment_id,
       (SELECT count(*) FROM thesis_claims o WHERE o.claim_id = c.id AND o.detached_at IS NULL) AS thesis_count
     FROM thesis_claims tc JOIN claims c ON c.id = tc.claim_id
     WHERE tc.thesis_id = ? AND tc.detached_at IS NULL ORDER BY c.status, c.next_review_on`,
  ).all(thesisId);
}
