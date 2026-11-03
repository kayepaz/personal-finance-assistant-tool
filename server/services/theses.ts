import { type DB, type Row, transaction } from "../db/db.ts";
import { uuidv7 } from "../lib/ids.ts";
import { badRequest, conflict, notFound } from "../lib/http.ts";
import { addDays } from "../lib/dates.ts";
import * as v from "../lib/validate.ts";
import { getAsset, getTrade } from "./assets.ts";
import { listRevisions, recordRevision } from "./revisions.ts";
import { closeFirings } from "./notifications.ts";

type Obj = Record<string, unknown>;

export const THESIS_STATUSES = ["draft", "active", "triggered", "closed", "abandoned"] as const;
export const OUTCOMES = ["played_out", "partly", "wrong", "unclear"] as const;
export const TRIGGER_TYPES = ["sell_on_date", "sell_after_days", "pct_change"] as const;
export const VERDICTS = ["still_true", "weakened", "no_longer_true"] as const;

const note = (body: Obj) => v.str(body, "note", { optional: true, max: 2000 }) ?? "";

// ---------- theses ----------

function rawThesis(db: DB, id: string): Row {
  const r = db.prepare("SELECT * FROM theses WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw notFound("Thesis not found");
  return r;
}

export function getThesis(db: DB, id: string): Row {
  const t = rawThesis(db, id);
  return {
    ...t,
    links: listLinks(db, id),
    claims: db.prepare("SELECT * FROM claims WHERE thesis_id = ? ORDER BY status, next_review_on").all(id),
    triggers: db.prepare("SELECT * FROM triggers WHERE thesis_id = ? ORDER BY status, created_at").all(id)
      .map(presentTrigger),
    reasoning: db.prepare("SELECT * FROM reasoning_entries WHERE thesis_id = ? ORDER BY created_at DESC").all(
      id,
    ),
  };
}

export function listTheses(db: DB, status?: string): Row[] {
  const rows = db.prepare(
    `SELECT t.*,
       (SELECT count(*) FROM thesis_links l WHERE l.thesis_id = t.id AND l.unlinked_at IS NULL) AS link_count,
       (SELECT count(*) FROM triggers g WHERE g.thesis_id = t.id AND g.status = 'active') AS trigger_count,
       (SELECT count(*) FROM claims c WHERE c.thesis_id = t.id AND c.status = 'active') AS claim_count
     FROM theses t ${status ? "WHERE t.status = ?" : ""} ORDER BY t.updated_at DESC`,
  ).all(...(status ? [status] : []));
  return rows;
}

export function createThesis(db: DB, body: Obj): Row {
  const id = uuidv7();
  const now = Date.now();
  return transaction(db, () => {
    db.prepare(
      "INSERT INTO theses(id, title, summary, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      id,
      v.reqStr(body, "title", { max: 200 }),
      v.str(body, "summary", { optional: true, max: 5000 }) ?? "",
      v.oneOf(body, "status", ["draft", "active"] as const, { optional: true }) ?? "draft",
      now,
      now,
    );
    recordRevision(db, "thesis", id, "create", rawThesis(db, id), note(body));
    return getThesis(db, id);
  });
}

/** Edit title/summary, or move through the lifecycle. Closing needs a retrospective and outcome. */
export function updateThesis(db: DB, id: string, body: Obj): Row {
  const current = rawThesis(db, id);
  return transaction(db, () => {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    const set = (c: string, val: string | number | null) => (sets.push(`${c} = ?`), vals.push(val));
    if (v.has(body, "title")) set("title", v.reqStr(body, "title", { max: 200 }));
    if (v.has(body, "summary")) set("summary", v.str(body, "summary", { optional: true, max: 5000 }) ?? "");
    if (v.has(body, "status")) {
      const next = v.oneOf(body, "status", THESIS_STATUSES)!;
      const from = current.status as string;
      if (from === "closed" || from === "abandoned") {
        if (next !== "active") throw conflict(`A ${from} thesis can only be re-opened as active`);
        set("closed_at", null);
      }
      if (next === "triggered") {
        throw badRequest("Theses become 'triggered' automatically when a trigger fires");
      }
      if (next === "closed") {
        set("retrospective", v.reqStr(body, "retrospective", { max: 10_000 }));
        set("outcome", v.oneOf(body, "outcome", OUTCOMES)!);
        set("closed_at", Date.now());
      }
      if (next === "abandoned") {
        set("retrospective", v.str(body, "retrospective", { optional: true, max: 10_000 }) ?? "");
        set("closed_at", Date.now());
      }
      set("status", next);
    }
    if (!sets.length) return getThesis(db, id);
    set("updated_at", Date.now());
    db.prepare(`UPDATE theses SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    const status = rawThesis(db, id).status;
    if (status === "closed" || status === "abandoned") {
      // A closed thesis stops alerting.
      for (const t of db.prepare("SELECT id FROM triggers WHERE thesis_id = ?").all(id)) {
        closeFirings(db, { triggerId: t.id as string }, "dismissed", `Thesis ${status}`);
      }
    }
    recordRevision(db, "thesis", id, "update", rawThesis(db, id), note(body));
    return getThesis(db, id);
  });
}

function touch(db: DB, thesisId: string) {
  db.prepare("UPDATE theses SET updated_at = ? WHERE id = ?").run(Date.now(), thesisId);
}

// ---------- links ----------

export function listLinks(db: DB, thesisId: string, includeUnlinked = false): Row[] {
  return db.prepare(
    `SELECT l.*, a.name AS asset_name, a.tracking, ac.name AS account_name,
            b.trade_date AS buy_date, b.quantity AS buy_quantity, b.price AS buy_price
     FROM thesis_links l
     JOIN assets a ON a.id = l.asset_id
     JOIN accounts ac ON ac.id = a.account_id
     LEFT JOIN trades b ON b.id = l.buy_trade_id
     WHERE l.thesis_id = ? ${includeUnlinked ? "" : "AND l.unlinked_at IS NULL"}
     ORDER BY l.linked_at`,
  ).all(thesisId);
}

export function linksForAsset(db: DB, assetId: string): Row[] {
  return db.prepare(
    `SELECT l.*, t.title AS thesis_title, t.status AS thesis_status FROM thesis_links l
     JOIN theses t ON t.id = l.thesis_id WHERE l.asset_id = ? AND l.unlinked_at IS NULL`,
  ).all(assetId);
}

export function createLink(db: DB, thesisId: string, body: Obj): Row {
  rawThesis(db, thesisId);
  const asset = getAsset(db, v.reqStr(body, "asset_id"));
  const buyId = v.str(body, "buy_trade_id", { optional: true }) || undefined;
  if (asset.tracking === "trades") {
    if (!buyId) throw badRequest("Link a specific purchase ('buy_trade_id') for trade-tracked assets");
    const buy = getTrade(db, buyId);
    if (buy.asset_id !== asset.id || buy.side !== "buy") {
      throw badRequest("That trade is not a purchase of this asset");
    }
  } else if (buyId) {
    throw badRequest("Value-tracked assets link to the asset, not a purchase");
  }
  const dup = db.prepare(
    `SELECT id FROM thesis_links WHERE thesis_id = ? AND asset_id = ? AND ifnull(buy_trade_id,'') = ?
     AND unlinked_at IS NULL`,
  ).get(thesisId, asset.id as string, buyId ?? "");
  if (dup) throw conflict("Already linked");
  const id = uuidv7();
  return transaction(db, () => {
    db.prepare(
      "INSERT INTO thesis_links(id, thesis_id, asset_id, buy_trade_id, linked_at) VALUES (?, ?, ?, ?, ?)",
    )
      .run(id, thesisId, asset.id as string, buyId ?? null, Date.now());
    const link = db.prepare("SELECT * FROM thesis_links WHERE id = ?").get(id) as Row;
    recordRevision(db, "thesis_link", id, "create", link, note(body));
    touch(db, thesisId);
    return link;
  });
}

export function unlink(db: DB, linkId: string, body: Obj): void {
  const link = db.prepare("SELECT * FROM thesis_links WHERE id = ?").get(linkId) as Row | undefined;
  if (!link) throw notFound("Link not found");
  if (link.unlinked_at) return;
  const reason = v.reqStr(body, "reason", { max: 2000 });
  transaction(db, () => {
    db.prepare("UPDATE thesis_links SET unlinked_at = ?, unlink_reason = ? WHERE id = ?").run(
      Date.now(),
      reason,
      linkId,
    );
    closeFirings(db, { linkId }, "dismissed", `Unlinked: ${reason}`);
    recordRevision(
      db,
      "thesis_link",
      linkId,
      "unlink",
      db.prepare("SELECT * FROM thesis_links WHERE id = ?").get(linkId) as Row,
      reason,
    );
    touch(db, link.thesis_id as string);
  });
}

// ---------- claims ----------

export function getClaim(db: DB, id: string): Row {
  const r = db.prepare("SELECT * FROM claims WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw notFound("Claim not found");
  return r;
}

export function createClaim(db: DB, thesisId: string, body: Obj, todayStr: string): Row {
  rawThesis(db, thesisId);
  const every = v.int(body, "review_every_days", { min: 1, max: 3650 })!;
  const id = uuidv7();
  const now = Date.now();
  return transaction(db, () => {
    db.prepare(
      `INSERT INTO claims(id, thesis_id, statement, review_every_days, next_review_on, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(
      id,
      thesisId,
      v.reqStr(body, "statement", { max: 2000 }),
      every,
      addDays(todayStr, every),
      now,
      now,
    );
    recordRevision(db, "claim", id, "create", getClaim(db, id), note(body));
    touch(db, thesisId);
    return getClaim(db, id);
  });
}

export function updateClaim(db: DB, id: string, body: Obj, todayStr: string): Row {
  const c = getClaim(db, id);
  return transaction(db, () => {
    if (v.has(body, "statement")) {
      db.prepare("UPDATE claims SET statement = ? WHERE id = ?").run(
        v.reqStr(body, "statement", { max: 2000 }),
        id,
      );
    }
    if (v.has(body, "review_every_days")) {
      const every = v.int(body, "review_every_days", { min: 1, max: 3650 })!;
      db.prepare("UPDATE claims SET review_every_days = ?, next_review_on = ? WHERE id = ?").run(
        every,
        addDays(todayStr, every),
        id,
      );
    }
    let action: "update" | "retire" = "update";
    if (v.has(body, "status")) {
      const s = v.oneOf(body, "status", ["active", "retired"] as const)!;
      db.prepare("UPDATE claims SET status = ? WHERE id = ?").run(s, id);
      if (s === "retired") {
        action = "retire";
        resolveRefNotifications(db, "claim", id, "adjusted", note(body) || "Claim retired");
      }
    }
    db.prepare("UPDATE claims SET updated_at = ? WHERE id = ?").run(Date.now(), id);
    recordRevision(db, "claim", id, action, getClaim(db, id), note(body));
    touch(db, c.thesis_id as string);
    return getClaim(db, id);
  });
}

export function reviewClaim(db: DB, id: string, body: Obj, todayStr: string): Row {
  const c = getClaim(db, id);
  const verdict = v.oneOf(body, "verdict", VERDICTS)!;
  const reviewNote = v.str(body, "note", { optional: true, max: 5000 }) ?? "";
  return transaction(db, () => {
    db.prepare("INSERT INTO claim_reviews(id, claim_id, verdict, note, reviewed_at) VALUES (?, ?, ?, ?, ?)")
      .run(uuidv7(), id, verdict, reviewNote, Date.now());
    db.prepare("UPDATE claims SET next_review_on = ?, updated_at = ? WHERE id = ?")
      .run(addDays(todayStr, c.review_every_days as number), Date.now(), id);
    resolveRefNotifications(db, "claim", id, "reviewed", `${verdict}${reviewNote ? `: ${reviewNote}` : ""}`);
    touch(db, c.thesis_id as string);
    return { ...getClaim(db, id), reviews: listClaimReviews(db, id) };
  });
}

export function listClaimReviews(db: DB, claimId: string): Row[] {
  return db.prepare("SELECT * FROM claim_reviews WHERE claim_id = ? ORDER BY reviewed_at DESC").all(claimId);
}

function resolveRefNotifications(
  db: DB,
  refType: string,
  refId: string,
  resolution: string,
  resolutionNote: string,
) {
  db.prepare(
    `UPDATE notifications SET status = 'resolved', resolution = ?, resolution_note = ?, resolved_at = ?
     WHERE ref_type = ? AND ref_id = ? AND status <> 'resolved'`,
  ).run(resolution, resolutionNote, Date.now(), refType, refId);
}

// ---------- reasoning ----------

export function addReasoning(db: DB, thesisId: string, body: Obj): Row {
  rawThesis(db, thesisId);
  const id = uuidv7();
  db.prepare("INSERT INTO reasoning_entries(id, thesis_id, body, created_at) VALUES (?, ?, ?, ?)")
    .run(id, thesisId, v.reqStr(body, "body", { max: 20_000 }), Date.now());
  touch(db, thesisId);
  return db.prepare("SELECT * FROM reasoning_entries WHERE id = ?").get(id) as Row;
}

// ---------- triggers ----------

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

function presentTrigger(r: Row): Row {
  return { ...r, params: JSON.parse(r.params as string) };
}

export function getTrigger(db: DB, id: string): Row {
  const r = db.prepare("SELECT * FROM triggers WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw notFound("Trigger not found");
  return presentTrigger(r);
}

export function createTrigger(db: DB, thesisId: string, body: Obj): Row {
  rawThesis(db, thesisId);
  const type = v.oneOf(body, "type", TRIGGER_TYPES)!;
  const params = validateTriggerParams(type, body.params);
  const id = uuidv7();
  const now = Date.now();
  return transaction(db, () => {
    db.prepare(
      `INSERT INTO triggers(id, thesis_id, type, params, label, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(
      id,
      thesisId,
      type,
      JSON.stringify(params),
      v.str(body, "label", { optional: true, max: 200 }) ?? "",
      now,
      now,
    );
    recordRevision(db, "trigger", id, "create", getTrigger(db, id), note(body));
    touch(db, thesisId);
    return getTrigger(db, id);
  });
}

/** Change params/label or retire. Any open alert for this trigger is resolved as 'adjusted'. */
export function updateTrigger(db: DB, id: string, body: Obj): Row {
  const t = getTrigger(db, id);
  if (t.status === "retired") throw conflict("This trigger is retired");
  const why = note(body);
  return transaction(db, () => {
    let action: "update" | "retire" = "update";
    if (v.has(body, "params")) {
      db.prepare("UPDATE triggers SET params = ? WHERE id = ?").run(
        JSON.stringify(validateTriggerParams(t.type as string, body.params)),
        id,
      );
    }
    if (v.has(body, "label")) {
      db.prepare("UPDATE triggers SET label = ? WHERE id = ?").run(
        v.str(body, "label", { optional: true, max: 200 }) ?? "",
        id,
      );
    }
    if (v.has(body, "status")) {
      if (v.oneOf(body, "status", ["active", "retired"] as const) === "retired") {
        db.prepare("UPDATE triggers SET status = 'retired' WHERE id = ?").run(id);
        action = "retire";
      }
    }
    db.prepare("UPDATE triggers SET updated_at = ? WHERE id = ?").run(Date.now(), id);
    closeFirings(
      db,
      { triggerId: id },
      "adjusted",
      why || (action === "retire" ? "Trigger removed" : "Trigger adjusted"),
    );
    recordRevision(db, "trigger", id, action, getTrigger(db, id), why);
    touch(db, t.thesis_id as string);
    return getTrigger(db, id);
  });
}

export function thesisHistory(db: DB, thesisId: string): Row[] {
  const out: Row[] = listRevisions(db, "thesis", thesisId).map((r) => ({
    ...r,
    entity_type: "thesis",
    entity_id: thesisId,
  }));
  const children: [string, "thesis_link" | "claim" | "trigger"][] = [
    ["SELECT id FROM thesis_links WHERE thesis_id = ?", "thesis_link"],
    ["SELECT id FROM claims WHERE thesis_id = ?", "claim"],
    ["SELECT id FROM triggers WHERE thesis_id = ?", "trigger"],
  ];
  for (const [sql, type] of children) {
    for (const row of db.prepare(sql).all(thesisId)) {
      out.push(
        ...listRevisions(db, type, row.id as string).map((r) => ({
          ...r,
          entity_type: type,
          entity_id: row.id,
        })),
      );
    }
  }
  return out.sort((a, b) => Number(b.created_at) - Number(a.created_at));
}
