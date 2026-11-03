import type { DB, Row } from "../db/db.ts";
import { uuidv7 } from "../lib/ids.ts";
import { badRequest, notFound } from "../lib/http.ts";
import * as v from "../lib/validate.ts";

export const ACCOUNT_KINDS = [
  "self_directed",
  "managed",
  "real_estate",
  "cash",
  "credit_card",
  "line_of_credit",
  "other_asset",
  "other_liability",
] as const;
export const LIABILITY_KINDS = new Set(["credit_card", "line_of_credit", "other_liability"]);

type Obj = Record<string, unknown>;

function present(r: Row): Row {
  return {
    ...r,
    tags: JSON.parse(r.tags as string),
    auto_update: r.auto_update === 1,
    is_liability: LIABILITY_KINDS.has(r.kind as string),
  };
}

export function getAccount(db: DB, id: string): Row {
  const r = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw notFound("Account not found");
  return present(r);
}

export function listAccounts(db: DB, includeArchived = false): Row[] {
  return db.prepare(
    `SELECT * FROM accounts ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY name`,
  ).all().map(present);
}

function checkLink(db: DB, id: string | undefined, self?: string) {
  if (!id) return;
  if (id === self) throw badRequest("An account can't link to itself");
  getAccount(db, id);
}

export function createAccount(db: DB, body: Obj, baseCurrency: string): Row {
  const id = uuidv7();
  const now = Date.now();
  const linked = v.str(body, "linked_account_id", { optional: true }) || undefined;
  checkLink(db, linked);
  db.prepare(
    `INSERT INTO accounts(id, name, kind, currency, tags, notes, update_every_days, auto_update, linked_account_id,
       created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    v.reqStr(body, "name", { max: 100 }),
    v.oneOf(body, "kind", ACCOUNT_KINDS)!,
    v.currency(body, "currency", { optional: true }) ?? baseCurrency,
    JSON.stringify(v.strArray(body, "tags", { optional: true }) ?? []),
    v.str(body, "notes", { optional: true, max: 5000 }) ?? "",
    v.int(body, "update_every_days", { optional: true, min: 1, max: 3650 }) ?? null,
    v.bool(body, "auto_update", { optional: true }) ? 1 : 0,
    linked ?? null,
    now,
    now,
  );
  return getAccount(db, id);
}

export function updateAccount(db: DB, id: string, body: Obj): Row {
  const current = getAccount(db, id);
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  const set = (col: string, val: string | number | null) => {
    sets.push(`${col} = ?`);
    vals.push(val);
  };
  if (v.has(body, "name")) set("name", v.reqStr(body, "name", { max: 100 }));
  if (v.has(body, "kind")) set("kind", v.oneOf(body, "kind", ACCOUNT_KINDS)!);
  if (v.has(body, "currency")) set("currency", v.currency(body, "currency")!);
  if (v.has(body, "tags")) set("tags", JSON.stringify(v.strArray(body, "tags")));
  if (v.has(body, "notes")) set("notes", v.str(body, "notes", { optional: true, max: 5000 }) ?? "");
  if (v.has(body, "update_every_days")) {
    set("update_every_days", v.int(body, "update_every_days", { optional: true, min: 1, max: 3650 }) ?? null);
  }
  if (v.has(body, "auto_update")) set("auto_update", v.bool(body, "auto_update") ? 1 : 0);
  if (v.has(body, "linked_account_id")) {
    const linked = v.str(body, "linked_account_id", { optional: true }) || undefined;
    checkLink(db, linked, id);
    set("linked_account_id", linked ?? null);
  }
  if (v.has(body, "archived")) set("archived_at", v.bool(body, "archived") ? (current.archived_at as number ?? Date.now()) : null);
  if (!sets.length) return current;
  set("updated_at", Date.now());
  db.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  return getAccount(db, id);
}

export function addSnapshot(db: DB, accountId: string, body: Obj, todayStr: string): Row {
  getAccount(db, accountId);
  const id = uuidv7();
  db.prepare(
    `INSERT INTO account_snapshots(id, account_id, as_of, kind, amount, source, note, created_at)
     VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)`,
  ).run(
    id,
    accountId,
    v.date(body, "as_of", { optional: true }) ?? todayStr,
    v.oneOf(body, "kind", ["value", "cash"] as const, { optional: true }) ?? "value",
    v.dec(body, "amount")!,
    v.str(body, "note", { optional: true, max: 1000 }) ?? "",
    Date.now(),
  );
  return db.prepare("SELECT * FROM account_snapshots WHERE id = ?").get(id) as Row;
}

export function listSnapshots(db: DB, accountId: string): Row[] {
  return db.prepare("SELECT * FROM account_snapshots WHERE account_id = ? ORDER BY as_of DESC, created_at DESC")
    .all(accountId);
}

export function latestSnapshot(db: DB, accountId: string, kind: "value" | "cash"): Row | undefined {
  return db.prepare(
    `SELECT * FROM account_snapshots WHERE account_id = ? AND kind = ? ORDER BY as_of DESC, created_at DESC LIMIT 1`,
  ).get(accountId, kind) as Row | undefined;
}
