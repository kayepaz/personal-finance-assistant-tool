import { type DB, type Row, transaction } from "../db/db.ts";
import { uuidv7 } from "../lib/ids.ts";
import { badRequest, conflict, notFound } from "../lib/http.ts";
import * as d from "../lib/decimal.ts";
import * as v from "../lib/validate.ts";
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

export function createAsset(db: DB, body: Obj): Row {
  const accountId = v.reqStr(body, "account_id");
  const account = getAccount(db, accountId);
  const instrumentId = v.str(body, "instrument_id", { optional: true }) || undefined;
  const instrument = instrumentId ? getInstrument(db, instrumentId) : undefined;
  const tracking = v.oneOf(body, "tracking", ["trades", "value"] as const, { optional: true }) ??
    (account.kind === "self_directed" && instrument ? "trades" : "value");
  if (tracking === "trades" && !instrument) throw badRequest("Trade-tracked assets need an instrument");
  if (instrument) {
    const dup = db.prepare("SELECT id FROM assets WHERE account_id = ? AND instrument_id = ?").get(accountId, instrument.id as string);
    if (dup) throw conflict(`${instrument.symbol} is already an asset in this account`);
  }
  const id = uuidv7();
  const now = Date.now();
  db.prepare(
    `INSERT INTO assets(id, account_id, instrument_id, name, tracking, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    accountId,
    instrument?.id as string ?? null,
    v.str(body, "name", { optional: true, max: 200 }) || (instrument?.symbol as string) || "",
    tracking,
    v.str(body, "notes", { optional: true, max: 5000 }) ?? "",
    now,
    now,
  );
  if (!getAsset(db, id).name) throw badRequest("'name' is required for assets without an instrument");
  return withPosition(db, getAsset(db, id));
}

export function updateAsset(db: DB, id: string, body: Obj): Row {
  getAsset(db, id);
  if (v.has(body, "name")) db.prepare("UPDATE assets SET name = ?, updated_at = ? WHERE id = ?").run(v.reqStr(body, "name", { max: 200 }), Date.now(), id);
  if (v.has(body, "notes")) db.prepare("UPDATE assets SET notes = ?, updated_at = ? WHERE id = ?").run(v.str(body, "notes", { optional: true, max: 5000 }) ?? "", Date.now(), id);
  if (v.has(body, "archived")) db.prepare("UPDATE assets SET archived_at = ?, updated_at = ? WHERE id = ?").run(v.bool(body, "archived") ? Date.now() : null, Date.now(), id);
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
  const buys = db.prepare("SELECT * FROM trades WHERE asset_id = ? AND side = 'buy' ORDER BY trade_date, id").all(assetId);
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
  if (asset.tracking !== "trades") return asset;
  const open = openBuys(db, asset.id as string);
  return {
    ...asset,
    quantity: d.sum(open.map((b) => b.open_quantity)),
    average_cost: averageCost(db, asset.id as string) ?? null,
  };
}

export function listTrades(db: DB, assetId: string): Row[] {
  const trades = db.prepare("SELECT * FROM trades WHERE asset_id = ? ORDER BY trade_date DESC, id DESC").all(assetId);
  return trades.map((t) =>
    t.side === "buy"
      ? { ...t, open_quantity: openQty(db, t) }
      : {
        ...t,
        allocations: db.prepare("SELECT buy_trade_id, quantity FROM sale_allocations WHERE sell_trade_id = ?").all(t.id as string),
      }
  );
}

export function recordBuy(db: DB, assetId: string, body: Obj): Row {
  const asset = getAsset(db, assetId);
  if (asset.tracking !== "trades") throw badRequest("This asset is value-tracked; record a value snapshot instead");
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
  if (new Set(parsed.map((p) => p.buyId)).size !== parsed.length) throw badRequest("Each purchase may appear once");
  if (d.cmp(d.sum(parsed.map((p) => p.quantity)), quantity) !== 0) {
    throw badRequest("Allocated quantities must add up to the sale quantity");
  }

  return transaction(db, () => {
    for (const p of parsed) {
      const buy = getTrade(db, p.buyId);
      if (buy.asset_id !== assetId || buy.side !== "buy") throw badRequest(`Trade ${p.buyId} is not a purchase of this asset`);
      if ((buy.trade_date as string) > tradeDate) throw badRequest(`Purchase on ${buy.trade_date} is after the sale date`);
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
    const ins = db.prepare("INSERT INTO sale_allocations(sell_trade_id, buy_trade_id, quantity) VALUES (?, ?, ?)");
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
    return links.every((l) => l.buy_trade_id && d.sign(openQty(db, getTrade(db, l.buy_trade_id as string))) === 0);
  });
}

export function deleteTrade(db: DB, id: string): void {
  const t = getTrade(db, id);
  transaction(db, () => {
    if (t.side === "buy") {
      if (d.sign(allocatedQty(db, id)) > 0) throw conflict("Delete the sales that close this purchase first");
      const linked = db.prepare("SELECT 1 FROM thesis_links WHERE buy_trade_id = ?").get(id);
      if (linked) throw conflict("This purchase is linked to a thesis; unlink it first");
    }
    db.prepare("DELETE FROM trades WHERE id = ?").run(id);
  });
}
