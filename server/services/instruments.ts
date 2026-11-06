import type { DB, Row } from "../db/db.ts";
import { uuidv7 } from "../lib/ids.ts";
import { conflict, notFound } from "../lib/http.ts";
import * as v from "../lib/validate.ts";

export const INSTRUMENT_KINDS = ["equity", "etf", "fund", "crypto", "metal", "other"] as const;

export function getInstrument(db: DB, id: string): Row {
  const r = db.prepare("SELECT * FROM instruments WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw notFound("Instrument not found");
  return r;
}

export function instrumentDetail(db: DB, id: string): Row {
  return {
    ...getInstrument(db, id),
    manual_prices: db.prepare(
      "SELECT price_date, close, note FROM manual_prices WHERE instrument_id = ? ORDER BY price_date DESC LIMIT 50",
    ).all(id),
    asset_count: Number(
      (db.prepare("SELECT count(*) AS n FROM assets WHERE instrument_id = ?").get(id) as Row).n,
    ),
  };
}

/** Edit an instrument. Symbol + exchange must stay unique. */
export function updateInstrument(db: DB, id: string, body: Record<string, unknown>): Row {
  const cur = getInstrument(db, id);
  const symbol = v.has(body, "symbol")
    ? v.reqStr(body, "symbol", { max: 32 }).toUpperCase()
    : cur.symbol as string;
  const exchange = v.has(body, "exchange")
    ? (v.str(body, "exchange", { optional: true, max: 32 }) ?? "").toUpperCase()
    : cur.exchange as string;
  const clash = db.prepare("SELECT id FROM instruments WHERE symbol = ? AND exchange = ? AND id <> ?").get(
    symbol,
    exchange,
    id,
  );
  if (clash) throw conflict(`${symbol}${exchange ? ` on ${exchange}` : ""} already exists`);
  db.prepare(
    `UPDATE instruments SET symbol = ?, exchange = ?, name = ?, kind = ?, currency = ?, provider_symbol = ?,
       price_source = ? WHERE id = ?`,
  ).run(
    symbol,
    exchange,
    v.has(body, "name") ? v.str(body, "name", { optional: true, max: 200 }) ?? "" : cur.name as string,
    v.has(body, "kind") ? v.oneOf(body, "kind", INSTRUMENT_KINDS)! : cur.kind as string,
    v.has(body, "currency") ? v.currency(body, "currency")! : cur.currency as string,
    v.has(body, "provider_symbol")
      ? v.str(body, "provider_symbol", { optional: true, max: 64 }) || symbol
      : cur.provider_symbol as string,
    v.has(body, "price_source")
      ? v.oneOf(body, "price_source", ["auto", "manual"] as const)!
      : cur.price_source as string,
    id,
  );
  return instrumentDetail(db, id);
}

/** Record a price by hand (art, metals, anything without a feed, or to correct a fetched price). */
export function addManualPrice(db: DB, id: string, body: Record<string, unknown>, todayStr: string): Row {
  getInstrument(db, id);
  db.prepare(
    `INSERT INTO manual_prices(instrument_id, price_date, close, note, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(instrument_id, price_date) DO UPDATE SET close = excluded.close, note = excluded.note,
       created_at = excluded.created_at`,
  ).run(
    id,
    v.date(body, "price_date", { optional: true }) ?? todayStr,
    v.dec(body, "close", { positive: true })!,
    v.str(body, "note", { optional: true, max: 500 }) ?? "",
    Date.now(),
  );
  return instrumentDetail(db, id);
}

export function deleteManualPrice(db: DB, id: string, date: string): void {
  const r = db.prepare("DELETE FROM manual_prices WHERE instrument_id = ? AND price_date = ?").run(id, date);
  if (r.changes === 0) throw notFound("Price not found");
}

export function listInstruments(db: DB): Row[] {
  return db.prepare("SELECT * FROM instruments ORDER BY symbol, exchange").all();
}

export function createInstrument(db: DB, body: Record<string, unknown>): Row {
  const symbol = v.reqStr(body, "symbol", { max: 32 }).toUpperCase();
  const exchange = (v.str(body, "exchange", { optional: true, max: 32 }) ?? "").toUpperCase();
  const existing = db.prepare("SELECT id FROM instruments WHERE symbol = ? AND exchange = ?").get(
    symbol,
    exchange,
  );
  if (existing) throw conflict(`${symbol}${exchange ? ` on ${exchange}` : ""} already exists`);
  const id = uuidv7();
  db.prepare(
    `INSERT INTO instruments(id, symbol, exchange, name, kind, currency, provider_symbol, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    symbol,
    exchange,
    v.str(body, "name", { optional: true, max: 200 }) ?? "",
    v.oneOf(body, "kind", INSTRUMENT_KINDS)!,
    v.currency(body, "currency")!,
    v.str(body, "provider_symbol", { optional: true, max: 64 }) || symbol,
    Date.now(),
  );
  if (v.has(body, "price_source")) {
    db.prepare("UPDATE instruments SET price_source = ? WHERE id = ?")
      .run(v.oneOf(body, "price_source", ["auto", "manual"] as const)!, id);
  }
  return getInstrument(db, id);
}
