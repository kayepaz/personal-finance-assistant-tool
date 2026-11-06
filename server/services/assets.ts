import { type DB, type Row, transaction } from "../db/db.ts";
import { uuidv7 } from "../lib/ids.ts";
import { badRequest, conflict, HttpError, notFound } from "../lib/http.ts";
import * as d from "../lib/decimal.ts";
import * as v from "../lib/validate.ts";
import { today } from "../lib/dates.ts";
import { getAccount } from "./accounts.ts";
import { getInstrument } from "./instruments.ts";

type Obj = Record<string, unknown>;

export function getAsset(db: DB, id: string): Row {
  const r = db.prepare(
    `SELECT a.*, i.symbol, i.exchange, i.currency AS instrument_currency, i.provider_symbol, i.kind AS instrument_kind,
            ac.name AS account_name, ac.currency AS account_currency
     FROM assets a
     JOIN accounts ac ON ac.id = a.account_id
     LEFT JOIN instruments i ON i.id = a.instrument_id
     WHERE a.id = ?`,
  ).get(id) as Row | undefined;
  if (!r) throw notFound("Asset not found");
  return r;
}

export function listAssets(db: DB, accountId?: string): Row[] {
  const rows = db.prepare(
    `SELECT a.id FROM assets a WHERE a.archived_at IS NULL ${accountId ? "AND a.account_id = ?" : ""}
     ORDER BY a.name`,
  ).all(...(accountId ? [accountId] : []));
  return rows.map((r) => withPosition(db, getAsset(db, r.id as string)));
}

export const REAL_ESTATE_CATEGORIES = ["property", "mortgage"] as const;

export function createAsset(db: DB, body: Obj, todayStr?: string): Row {
  const accountId = v.reqStr(body, "account_id");
  const account = getAccount(db, accountId);
  const name = v.str(body, "name", { optional: true, max: 200 });
  const notes = v.str(body, "notes", { optional: true, max: 5000 }) ?? "";
  const now = Date.now();

  if (account.kind === "real_estate") {
    // Real estate accounts hold houses (declared value) and mortgages (amount owed), each with dated values.
    if (body.instrument_id) {
      throw badRequest("Real estate accounts hold houses and mortgages, not market instruments");
    }
    const category = v.oneOf(body, "category", REAL_ESTATE_CATEGORIES)!;
    if (!name) throw badRequest("'name' is required, e.g. the address");
    const id = uuidv7();
    return transaction(db, () => {
      db.prepare(
        `INSERT INTO assets(id, account_id, instrument_id, name, tracking, notes, category, created_at, updated_at)
         VALUES (?, ?, NULL, ?, 'value', ?, ?, ?, ?)`,
      ).run(id, accountId, name, notes, category, now, now);
      addAssetValue(
        db,
        id,
        { amount: body.value, as_of: body.as_of, note: body.value_note },
        todayStr ?? today(),
      );
      return withPosition(db, getAsset(db, id));
    });
  }
  if (body.category) throw badRequest("Only real estate accounts have houses and mortgages");
  if (account.kind === "cash") {
    throw badRequest("Cash accounts just record a balance; they don't hold assets");
  }

  const instrumentId = v.str(body, "instrument_id", { optional: true }) || undefined;
  const instrument = instrumentId ? getInstrument(db, instrumentId) : undefined;
  const tracking = v.oneOf(body, "tracking", ["trades", "value"] as const, { optional: true }) ??
    (account.kind === "self_directed" && instrument ? "trades" : "value");
  if (tracking === "trades" && !instrument) throw badRequest("Trade-tracked assets need an instrument");
  if (!name && !instrument) throw badRequest("'name' is required for assets without an instrument");
  if (instrument) {
    const dup = db.prepare("SELECT id FROM assets WHERE account_id = ? AND instrument_id = ?").get(
      accountId,
      instrument.id as string,
    );
    if (dup) throw conflict(`${instrument.symbol} is already an asset in this account`);
  }
  const id = uuidv7();
  db.prepare(
    `INSERT INTO assets(id, account_id, instrument_id, name, tracking, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    accountId,
    instrument?.id as string ?? null,
    name || (instrument!.symbol as string),
    tracking,
    notes,
    now,
    now,
  );
  return withPosition(db, getAsset(db, id));
}

// ---------- dated values for houses and mortgages ----------

export function addAssetValue(db: DB, assetId: string, body: Obj, todayStr: string): Row {
  const asset = getAsset(db, assetId);
  if (!asset.category) throw badRequest("Only houses and mortgages record values this way");
  const amount = v.dec(body, "amount", { nonNegative: true });
  if (amount === undefined) {
    throw badRequest(asset.category === "mortgage" ? "Enter the amount owed" : "Enter the declared value");
  }
  const id = uuidv7();
  db.prepare(
    "INSERT INTO asset_values(id, asset_id, as_of, amount, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    assetId,
    v.date(body, "as_of", { optional: true }) ?? todayStr,
    amount,
    v.str(body, "note", { optional: true, max: 1000 }) ?? "",
    Date.now(),
  );
  db.prepare("UPDATE assets SET updated_at = ? WHERE id = ?").run(Date.now(), assetId);
  return db.prepare("SELECT * FROM asset_values WHERE id = ?").get(id) as Row;
}

export function deleteAssetValue(db: DB, id: string): void {
  const row = db.prepare("SELECT asset_id FROM asset_values WHERE id = ?").get(id) as Row | undefined;
  if (!row) throw notFound("Value not found");
  const count = Number(
    (db.prepare("SELECT count(*) AS n FROM asset_values WHERE asset_id = ?").get(
      row.asset_id as string,
    ) as Row).n,
  );
  if (count <= 1) throw conflict("This is the only value recorded; add a new one before deleting it");
  db.prepare("DELETE FROM asset_values WHERE id = ?").run(id);
}

export function listAssetValues(db: DB, assetId: string): Row[] {
  return db.prepare("SELECT * FROM asset_values WHERE asset_id = ? ORDER BY as_of DESC, created_at DESC").all(
    assetId,
  );
}

export function latestAssetValue(db: DB, assetId: string): Row | undefined {
  return db.prepare(
    "SELECT * FROM asset_values WHERE asset_id = ? ORDER BY as_of DESC, created_at DESC LIMIT 1",
  ).get(assetId) as Row | undefined;
}

// ---------- deleting ----------

export interface AssetDependents {
  trades: { id: string; side: string; trade_date: string; quantity: string; price: string }[];
  theses: { id: string; title: string; link_id: string }[];
}

/** What must be removed before an asset can be deleted: its trades and its active thesis links. */
export function assetDependents(db: DB, id: string): AssetDependents {
  getAsset(db, id);
  return {
    // Sales first: a purchase can't be deleted while a sale still closes it.
    trades: db.prepare(
      `SELECT id, side, trade_date, quantity, price FROM trades WHERE asset_id = ?
       ORDER BY CASE side WHEN 'sell' THEN 0 ELSE 1 END, trade_date DESC`,
    ).all(id) as unknown as AssetDependents["trades"],
    theses: db.prepare(
      `SELECT t.id, t.title, l.id AS link_id FROM thesis_links l JOIN theses t ON t.id = l.thesis_id
       WHERE l.asset_id = ? AND l.unlinked_at IS NULL ORDER BY t.title`,
    ).all(id) as unknown as AssetDependents["theses"],
  };
}

/**
 * Delete an asset that has no trades and no active thesis links. Its own value history goes with it, as do
 * past (already unlinked) thesis links; thesis history keeps their revision records.
 */
export function deleteAsset(db: DB, id: string): void {
  const deps = assetDependents(db, id);
  if (deps.trades.length || deps.theses.length) {
    throw new HttpError(409, "Delete this asset's trades and unlink it from its theses first", deps);
  }
  transaction(db, () => {
    db.prepare("DELETE FROM thesis_links WHERE asset_id = ?").run(id);
    db.prepare("DELETE FROM assets WHERE id = ?").run(id);
  });
}

export function updateAsset(db: DB, id: string, body: Obj): Row {
  getAsset(db, id);
  if (v.has(body, "name")) {
    db.prepare("UPDATE assets SET name = ?, updated_at = ? WHERE id = ?").run(
      v.reqStr(body, "name", { max: 200 }),
      Date.now(),
      id,
    );
  }
  if (v.has(body, "notes")) {
    db.prepare("UPDATE assets SET notes = ?, updated_at = ? WHERE id = ?").run(
      v.str(body, "notes", { optional: true, max: 5000 }) ?? "",
      Date.now(),
      id,
    );
  }
  if (v.has(body, "archived")) {
    db.prepare("UPDATE assets SET archived_at = ?, updated_at = ? WHERE id = ?").run(
      v.bool(body, "archived") ? Date.now() : null,
      Date.now(),
      id,
    );
  }
  return withPosition(db, getAsset(db, id));
}

// ---------- trades ----------

export function getTrade(db: DB, id: string): Row {
  const r = db.prepare("SELECT * FROM trades WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw notFound("Trade not found");
  return r;
}

export function allocatedQty(db: DB, buyId: string): string {
  const rows = db.prepare("SELECT quantity FROM sale_allocations WHERE buy_trade_id = ?").all(buyId);
  return d.sum(rows.map((r) => r.quantity as string));
}

export function openQty(db: DB, buy: Row): string {
  return d.sub(buy.quantity as string, allocatedQty(db, buy.id as string));
}

export interface OpenBuy {
  id: string;
  trade_date: string;
  price: string;
  quantity: string;
  open_quantity: string;
}

export function openBuys(db: DB, assetId: string): OpenBuy[] {
  const buys = db.prepare("SELECT * FROM trades WHERE asset_id = ? AND side = 'buy' ORDER BY trade_date, id")
    .all(assetId);
  return buys
    .map((b) => ({
      id: b.id as string,
      trade_date: b.trade_date as string,
      price: b.price as string,
      quantity: b.quantity as string,
      open_quantity: openQty(db, b),
    }))
    .filter((b) => d.sign(b.open_quantity) > 0);
}

/** Quantity-weighted average price of the open buys. Undefined when nothing is open. */
export function averageCost(db: DB, assetId: string): string | undefined {
  const open = openBuys(db, assetId);
  const qty = d.sum(open.map((b) => b.open_quantity));
  if (d.sign(qty) === 0) return undefined;
  const cost = d.sum(open.map((b) => d.mul(b.open_quantity, b.price)));
  return d.round(d.div(cost, qty), 8);
}

export function withPosition(db: DB, asset: Row): Row {
  if (asset.category) {
    const latest = latestAssetValue(db, asset.id as string);
    return { ...asset, value: latest?.amount ?? null, value_as_of: latest?.as_of ?? null };
  }
  if (asset.tracking !== "trades") return asset;
  const open = openBuys(db, asset.id as string);
  return {
    ...asset,
    quantity: d.sum(open.map((b) => b.open_quantity)),
    average_cost: averageCost(db, asset.id as string) ?? null,
  };
}

export function listTrades(db: DB, assetId: string): Row[] {
  const trades = db.prepare("SELECT * FROM trades WHERE asset_id = ? ORDER BY trade_date DESC, id DESC").all(
    assetId,
  );
  return trades.map((t) =>
    t.side === "buy" ? { ...t, open_quantity: openQty(db, t) } : {
      ...t,
      allocations: db.prepare("SELECT buy_trade_id, quantity FROM sale_allocations WHERE sell_trade_id = ?")
        .all(t.id as string),
    }
  );
}

export function recordBuy(db: DB, assetId: string, body: Obj): Row {
  const asset = getAsset(db, assetId);
  if (asset.tracking !== "trades") {
    throw badRequest("This asset is value-tracked; record a value snapshot instead");
  }
  const id = uuidv7();
  db.prepare(
    `INSERT INTO trades(id, asset_id, side, trade_date, quantity, price, fees, notes, created_at)
     VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    assetId,
    v.date(body, "trade_date")!,
    v.dec(body, "quantity", { positive: true })!,
    v.dec(body, "price", { nonNegative: true })!,
    v.dec(body, "fees", { optional: true, nonNegative: true }) ?? "0",
    v.str(body, "notes", { optional: true, max: 2000 }) ?? "",
    Date.now(),
  );
  return getTrade(db, id);
}

export interface SellResult {
  trade: Row;
  /** Theses whose linked purchases are now all fully sold — the UI offers to close them. */
  fully_sold_theses: Row[];
}

export function recordSell(db: DB, assetId: string, body: Obj): SellResult {
  const asset = getAsset(db, assetId);
  if (asset.tracking !== "trades") throw badRequest("This asset is value-tracked");
  const tradeDate = v.date(body, "trade_date")!;
  const quantity = v.dec(body, "quantity", { positive: true })!;
  const price = v.dec(body, "price", { nonNegative: true })!;
  const allocations = body.allocations;
  if (!Array.isArray(allocations) || allocations.length === 0) {
    throw badRequest("'allocations' must list which purchases this sale closes");
  }
  const parsed = allocations.map((a, i) => {
    if (typeof a !== "object" || a === null) throw badRequest(`allocations[${i}] must be an object`);
    const o = a as Obj;
    return { buyId: v.reqStr(o, "buy_trade_id"), quantity: v.dec(o, "quantity", { positive: true })! };
  });
  if (new Set(parsed.map((p) => p.buyId)).size !== parsed.length) {
    throw badRequest("Each purchase may appear once");
  }
  if (d.cmp(d.sum(parsed.map((p) => p.quantity)), quantity) !== 0) {
    throw badRequest("Allocated quantities must add up to the sale quantity");
  }

  return transaction(db, () => {
    for (const p of parsed) {
      const buy = getTrade(db, p.buyId);
      if (buy.asset_id !== assetId || buy.side !== "buy") {
        throw badRequest(`Trade ${p.buyId} is not a purchase of this asset`);
      }
      if ((buy.trade_date as string) > tradeDate) {
        throw badRequest(`Purchase on ${buy.trade_date} is after the sale date`);
      }
      if (d.cmp(p.quantity, openQty(db, buy)) > 0) {
        throw badRequest(`Purchase on ${buy.trade_date} only has ${openQty(db, buy)} left to sell`);
      }
    }
    const id = uuidv7();
    db.prepare(
      `INSERT INTO trades(id, asset_id, side, trade_date, quantity, price, fees, notes, created_at)
       VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      assetId,
      tradeDate,
      quantity,
      price,
      v.dec(body, "fees", { optional: true, nonNegative: true }) ?? "0",
      v.str(body, "notes", { optional: true, max: 2000 }) ?? "",
      Date.now(),
    );
    const ins = db.prepare(
      "INSERT INTO sale_allocations(sell_trade_id, buy_trade_id, quantity) VALUES (?, ?, ?)",
    );
    for (const p of parsed) ins.run(id, p.buyId, p.quantity);
    return { trade: getTrade(db, id), fully_sold_theses: fullySoldTheses(db, parsed.map((p) => p.buyId)) };
  });
}

/** Active/triggered theses touching these buys whose every active purchase link is now fully sold. */
function fullySoldTheses(db: DB, buyIds: string[]): Row[] {
  if (!buyIds.length) return [];
  const theses = db.prepare(
    `SELECT DISTINCT t.id, t.title FROM thesis_links l JOIN theses t ON t.id = l.thesis_id
     WHERE l.unlinked_at IS NULL AND t.status IN ('active','triggered')
       AND l.buy_trade_id IN (${buyIds.map(() => "?").join(",")})`,
  ).all(...buyIds);
  return theses.filter((t) => {
    const links = db.prepare(
      "SELECT buy_trade_id FROM thesis_links WHERE thesis_id = ? AND unlinked_at IS NULL",
    ).all(t.id as string);
    return links.every((l) =>
      l.buy_trade_id && d.sign(openQty(db, getTrade(db, l.buy_trade_id as string))) === 0
    );
  });
}

/**
 * Correct a trade. Buys: date, quantity, price, fees, notes — quantity can't drop below what sales have already
 * closed, and the date can't move after those sales. Sells: date, price, fees, notes — to change a sale's
 * quantity or which purchases it closed, delete it and record it again.
 */
export function updateTrade(db: DB, id: string, body: Obj): Row {
  const t = getTrade(db, id);
  return transaction(db, () => {
    const sets: string[] = [];
    const vals: string[] = [];
    const set = (c: string, val: string) => (sets.push(`${c} = ?`), vals.push(val));
    if (v.has(body, "trade_date")) {
      const date = v.date(body, "trade_date")!;
      if (t.side === "buy") {
        const firstSale = db.prepare(
          `SELECT min(s.trade_date) AS d FROM sale_allocations a JOIN trades s ON s.id = a.sell_trade_id
           WHERE a.buy_trade_id = ?`,
        ).get(id) as Row;
        if (firstSale.d && date > (firstSale.d as string)) {
          throw badRequest(
            `This purchase was partly sold on ${firstSale.d}; its date can't be later than that`,
          );
        }
      } else {
        const lastBuy = db.prepare(
          `SELECT max(b.trade_date) AS d FROM sale_allocations a JOIN trades b ON b.id = a.buy_trade_id
           WHERE a.sell_trade_id = ?`,
        ).get(id) as Row;
        if (lastBuy.d && date < (lastBuy.d as string)) {
          throw badRequest(
            `This sale closes a purchase from ${lastBuy.d}; its date can't be earlier than that`,
          );
        }
      }
      set("trade_date", date);
    }
    if (v.has(body, "quantity")) {
      if (t.side === "sell") {
        throw badRequest("To change how much was sold, delete the sale and record it again");
      }
      const qty = v.dec(body, "quantity", { positive: true })!;
      const sold = allocatedQty(db, id);
      if (d.cmp(qty, sold) < 0) throw badRequest(`${sold} of this purchase has already been sold`);
      set("quantity", qty);
    }
    if (v.has(body, "price")) set("price", v.dec(body, "price", { nonNegative: true })!);
    if (v.has(body, "fees")) set("fees", v.dec(body, "fees", { optional: true, nonNegative: true }) ?? "0");
    if (v.has(body, "notes")) set("notes", v.str(body, "notes", { optional: true, max: 2000 }) ?? "");
    if (sets.length) db.prepare(`UPDATE trades SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    return getTrade(db, id);
  });
}

export function deleteTrade(db: DB, id: string): void {
  const t = getTrade(db, id);
  transaction(db, () => {
    if (t.side === "buy") {
      if (d.sign(allocatedQty(db, id)) > 0) throw conflict("Delete the sales that close this purchase first");
      const linked = db.prepare("SELECT 1 FROM thesis_links WHERE buy_trade_id = ? AND unlinked_at IS NULL")
        .get(id);
      if (linked) throw conflict("This purchase is linked to a thesis; unlink it first");
      // Past (unlinked) links to this purchase go with it; their revision history remains.
      db.prepare("DELETE FROM thesis_links WHERE buy_trade_id = ?").run(id);
    }
    db.prepare("DELETE FROM trades WHERE id = ?").run(id);
  });
}
