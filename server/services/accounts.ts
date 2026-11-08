import { type DB, type Row, transaction } from "../db/db.ts";
import { uuidv7 } from "../lib/ids.ts";
import { badRequest, conflict, HttpError, notFound } from "../lib/http.ts";
import * as v from "../lib/validate.ts";

/** 'cash' is shown as "Simple asset or liability": one balance, positive = asset, negative = liability. */
export const ACCOUNT_KINDS = ["self_directed", "managed", "real_estate", "cash"] as const;

type Obj = Record<string, unknown>;

function present(r: Row): Row {
  return {
    ...r,
    tags: JSON.parse(r.tags as string),
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

export function createAccount(db: DB, body: Obj, baseCurrency: string): Row {
  const id = uuidv7();
  const now = Date.now();
  db.prepare(
    `INSERT INTO accounts(id, name, kind, currency, tags, notes, update_every_days,
       created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    v.reqStr(body, "name", { max: 100 }),
    v.oneOf(body, "kind", ACCOUNT_KINDS)!,
    v.currency(body, "currency", { optional: true }) ?? baseCurrency,
    JSON.stringify(v.strArray(body, "tags", { optional: true }) ?? []),
    v.str(body, "notes", { optional: true, max: 5000 }) ?? "",
    v.int(body, "update_every_days", { optional: true, min: 1, max: 3650 }) ?? null,
    now,
    now,
  );
  return getAccount(db, id);
}

export interface KindChange {
  /** Today's value of the account in its own currency, used when it stops being self-directed. */
  currentValue?: string | null;
  today: string;
}

/**
 * Edit an account. Changing the type between self-directed (records cash; holdings are priced) and any other
 * type (records total value) re-files the balance history so it keeps showing: other → self-directed turns
 * values into cash; self-directed → other turns cash entries into values and records today's total
 * (holdings + cash) as the starting value.
 */
export function updateAccount(db: DB, id: string, body: Obj, change?: KindChange): Row {
  const current = getAccount(db, id);
  const newKind = v.has(body, "kind") ? v.oneOf(body, "kind", ACCOUNT_KINDS)! : (current.kind as string);
  const crossing = (current.kind === "self_directed") !== (newKind === "self_directed");
  const assetCount = Number(
    (db.prepare("SELECT count(*) AS n FROM assets WHERE account_id = ?").get(id) as Row).n,
  );
  if (current.kind === "real_estate" && newKind !== "real_estate" && assetCount) {
    throw conflict("Remove this account's houses and mortgages before changing its type");
  }
  if (current.kind !== "real_estate" && newKind === "real_estate" && assetCount) {
    throw conflict(
      "Real estate accounts hold only houses and mortgages; move or remove this account's assets first",
    );
  }
  if (newKind === "cash" && current.kind !== "cash" && assetCount) {
    throw conflict(
      "Simple asset or liability accounts don't hold assets; move or remove this account's assets first",
    );
  }
  const intoRealEstate = current.kind !== "real_estate" && newKind === "real_estate";
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  const set = (col: string, val: string | number | null) => {
    sets.push(`${col} = ?`);
    vals.push(val);
  };
  if (v.has(body, "name")) set("name", v.reqStr(body, "name", { max: 100 }));
  if (v.has(body, "kind")) set("kind", newKind);
  if (v.has(body, "currency")) set("currency", v.currency(body, "currency")!);
  if (v.has(body, "tags")) set("tags", JSON.stringify(v.strArray(body, "tags")));
  if (v.has(body, "notes")) set("notes", v.str(body, "notes", { optional: true, max: 5000 }) ?? "");
  if (v.has(body, "update_every_days")) {
    set("update_every_days", v.int(body, "update_every_days", { optional: true, min: 1, max: 3650 }) ?? null);
  }
  if (v.has(body, "archived")) {
    set("archived_at", v.bool(body, "archived") ? (current.archived_at as number ?? Date.now()) : null);
  }
  if (!sets.length) return current;
  set("updated_at", Date.now());
  return transaction(db, () => {
    db.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    if (intoRealEstate) {
      // Balances recorded on the account become the value history of a house named after it.
      const snaps = db.prepare("SELECT * FROM account_snapshots WHERE account_id = ?").all(id);
      if (snaps.length) {
        const assetId = uuidv7();
        const now = Date.now();
        db.prepare(
          `INSERT INTO assets(id, account_id, instrument_id, name, tracking, notes, category, created_at, updated_at)
           VALUES (?, ?, NULL, ?, 'value', '', 'property', ?, ?)`,
        ).run(assetId, id, current.name as string, now, now);
        const ins = db.prepare(
          "INSERT INTO asset_values(id, asset_id, as_of, amount, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        );
        for (const sn of snaps) {
          ins.run(
            uuidv7(),
            assetId,
            sn.as_of as string,
            sn.amount as string,
            sn.note as string,
            sn.created_at as number,
          );
        }
        db.prepare("DELETE FROM account_snapshots WHERE account_id = ?").run(id);
      }
    } else if (crossing) {
      if (newKind === "self_directed") {
        db.prepare("UPDATE account_snapshots SET kind = 'cash' WHERE account_id = ? AND kind = 'value'").run(
          id,
        );
      } else {
        db.prepare("UPDATE account_snapshots SET kind = 'value' WHERE account_id = ? AND kind = 'cash'").run(
          id,
        );
        const value = change?.currentValue;
        if (value && change) {
          db.prepare(
            `INSERT INTO account_snapshots(id, account_id, as_of, kind, amount, source, note, created_at)
             VALUES (?, ?, ?, 'value', ?, 'auto', 'Holdings + cash when the account type changed', ?)`,
          ).run(uuidv7(), id, change.today, value, Date.now());
        }
      }
    }
    return getAccount(db, id);
  });
}

/** The kind of balance an account records: self-directed accounts record cash (holdings are priced); all others
 * record their total value. */
export function snapshotKind(account: Row): "cash" | "value" {
  return account.kind === "self_directed" ? "cash" : "value";
}

export function addSnapshot(db: DB, accountId: string, body: Obj, todayStr: string): Row {
  const account = getAccount(db, accountId);
  if (account.kind === "real_estate") {
    throw badRequest("Real estate accounts are valued from their houses and mortgages; update those instead");
  }
  const kind = snapshotKind(account);
  const asked = v.oneOf(body, "kind", ["value", "cash"] as const, { optional: true });
  if (asked && asked !== kind) {
    throw badRequest(
      kind === "cash"
        ? "Self-directed accounts record their cash balance; holdings are valued from prices"
        : "This account records its total value, not a separate cash balance",
    );
  }
  const id = uuidv7();
  db.prepare(
    `INSERT INTO account_snapshots(id, account_id, as_of, kind, amount, source, note, created_at)
     VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)`,
  ).run(
    id,
    accountId,
    v.date(body, "as_of", { optional: true }) ?? todayStr,
    kind,
    v.dec(body, "amount")!,
    v.str(body, "note", { optional: true, max: 1000 }) ?? "",
    Date.now(),
  );
  return db.prepare("SELECT * FROM account_snapshots WHERE id = ?").get(id) as Row;
}

export function deleteSnapshot(db: DB, id: string): void {
  const r = db.prepare("DELETE FROM account_snapshots WHERE id = ?").run(id);
  if (r.changes === 0) throw notFound("Balance entry not found");
}

export function listSnapshots(db: DB, accountId: string): Row[] {
  return db.prepare(
    "SELECT * FROM account_snapshots WHERE account_id = ? ORDER BY as_of DESC, created_at DESC",
  )
    .all(accountId);
}

export function latestSnapshot(db: DB, accountId: string, kind: "value" | "cash"): Row | undefined {
  return db.prepare(
    `SELECT * FROM account_snapshots WHERE account_id = ? AND kind = ? ORDER BY as_of DESC, created_at DESC LIMIT 1`,
  ).get(accountId, kind) as Row | undefined;
}

// ---------- deleting ----------

export interface AccountDependents {
  assets: { id: string; name: string; category: string | null; trades: number; theses: string[] }[];
  balance_entries: number;
}

/** Assets block deletion; balance history is deleted with the account. */
export function accountDependents(db: DB, id: string): AccountDependents {
  getAccount(db, id);
  const assets = db.prepare("SELECT id, name, category FROM assets WHERE account_id = ? ORDER BY name").all(
    id,
  );
  return {
    assets: assets.map((a) => ({
      id: a.id as string,
      name: a.name as string,
      category: (a.category as string | null) ?? null,
      trades: Number(
        (db.prepare("SELECT count(*) AS n FROM trades WHERE asset_id = ?").get(a.id as string) as Row).n,
      ),
      theses: db.prepare(
        `SELECT t.title FROM thesis_links l JOIN theses t ON t.id = l.thesis_id
         WHERE l.asset_id = ? AND l.unlinked_at IS NULL ORDER BY t.title`,
      ).all(a.id as string).map((t) => t.title as string),
    })),
    balance_entries: Number(
      (db.prepare("SELECT count(*) AS n FROM account_snapshots WHERE account_id = ?").get(id) as Row).n,
    ),
  };
}

export function deleteAccount(db: DB, id: string): void {
  const deps = accountDependents(db, id);
  if (deps.assets.length) throw new HttpError(409, "Delete this account's assets first", deps);
  transaction(db, () => {
    db.prepare("DELETE FROM notifications WHERE ref_type = 'account' AND ref_id = ?").run(id);
    db.prepare("DELETE FROM accounts WHERE id = ?").run(id); // balance history cascades
  });
}
