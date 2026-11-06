import { type DB, type Row, transaction } from "../db/db.ts";
import { uuidv7 } from "../lib/ids.ts";
import { badRequest, conflict, notFound } from "../lib/http.ts";
import * as v from "../lib/validate.ts";
import { getAsset, getTrade } from "./assets.ts";
import { type EntityType, listRevisions, recordRevision } from "./revisions.ts";
import { closeFirings } from "./notifications.ts";
import { claimsForThesis } from "./claims.ts";
import { triggersForThesis } from "./triggers.ts";

type Obj = Record<string, unknown>;

export const THESIS_STATUSES = ["draft", "active", "triggered", "closed", "abandoned"] as const;
export const OUTCOMES = ["played_out", "partly", "wrong", "unclear"] as const;

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
    claims: claimsForThesis(db, id),
    triggers: triggersForThesis(db, id),
    reasoning: db.prepare("SELECT * FROM reasoning_entries WHERE thesis_id = ? ORDER BY created_at DESC").all(
      id,
    ),
  };
}

export function listTheses(db: DB, status?: string): Row[] {
  const rows = db.prepare(
    `SELECT t.*,
       (SELECT count(*) FROM thesis_links l WHERE l.thesis_id = t.id AND l.unlinked_at IS NULL) AS link_count,
       (SELECT count(*) FROM thesis_triggers tt JOIN triggers g ON g.id = tt.trigger_id
         WHERE tt.thesis_id = t.id AND tt.detached_at IS NULL AND g.status = 'active') AS trigger_count,
       (SELECT count(*) FROM thesis_claims tc JOIN claims c ON c.id = tc.claim_id
         WHERE tc.thesis_id = t.id AND tc.detached_at IS NULL AND c.status = 'active') AS claim_count
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
      closeFirings(db, { thesisId: id }, "dismissed", `Thesis ${status}`);
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
  if (asset.category === "mortgage") {
    throw badRequest("A mortgage can't be part of a thesis; link the house instead");
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

// ---------- reasoning ----------

export function addReasoning(db: DB, thesisId: string, body: Obj): Row {
  rawThesis(db, thesisId);
  const id = uuidv7();
  db.prepare("INSERT INTO reasoning_entries(id, thesis_id, body, created_at) VALUES (?, ?, ?, ?)")
    .run(id, thesisId, v.reqStr(body, "body", { max: 20_000 }), Date.now());
  touch(db, thesisId);
  return db.prepare("SELECT * FROM reasoning_entries WHERE id = ?").get(id) as Row;
}

/** Everything that changed on this thesis, plus edits to the claims and triggers it has ever used. */
export function thesisHistory(db: DB, thesisId: string): Row[] {
  const out: Row[] = [];
  const name = (sql: string, id: unknown) => {
    const r = id ? db.prepare(sql).get(id as string) as Row | undefined : undefined;
    return r ? String(Object.values(r)[0] ?? "") : "";
  };
  const claimName = (id: unknown) => name("SELECT statement FROM claims WHERE id = ?", id);
  const triggerName = (id: unknown) => {
    const t = id
      ? db.prepare("SELECT label, type FROM triggers WHERE id = ?").get(id as string) as Row | undefined
      : undefined;
    return t ? String(t.label || String(t.type).replaceAll("_", " ")) : "";
  };
  const subject = (type: EntityType, data: Row): string => {
    switch (type) {
      case "thesis":
        return String(data.title ?? "");
      case "thesis_link":
        return name("SELECT name FROM assets WHERE id = ?", data.asset_id) || "(deleted asset)";
      case "claim":
        return String(data.statement ?? "");
      case "thesis_claim":
        return claimName(data.claim_id);
      case "trigger":
        return String(data.label || String(data.type ?? "").replaceAll("_", " "));
      case "thesis_trigger":
        return triggerName(data.trigger_id);
    }
  };
  const add = (type: EntityType, id: string) =>
    out.push(
      ...listRevisions(db, type, id).map((r) => ({
        ...r,
        entity_type: type,
        entity_id: id,
        subject: subject(type, r.data as Row),
      })),
    );
  add("thesis", thesisId);
  // Links and attachments are found through their revisions, so history survives a deleted asset or trade.
  const viaRevisions = (type: string) =>
    `SELECT DISTINCT entity_id AS id FROM revisions
     WHERE entity_type = '${type}' AND json_extract(data, '$.thesis_id') = ?`;
  const children: [string, EntityType][] = [
    [viaRevisions("thesis_link"), "thesis_link"],
    [viaRevisions("thesis_claim"), "thesis_claim"],
    [viaRevisions("thesis_trigger"), "thesis_trigger"],
    ["SELECT DISTINCT claim_id AS id FROM thesis_claims WHERE thesis_id = ?", "claim"],
    ["SELECT DISTINCT trigger_id AS id FROM thesis_triggers WHERE thesis_id = ?", "trigger"],
  ];
  for (const [sql, type] of children) {
    for (const row of db.prepare(sql).all(thesisId)) add(type, row.id as string);
  }
  return out.sort((a, b) => Number(b.created_at) - Number(a.created_at));
}
