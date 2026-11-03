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

export function listInstruments(db: DB): Row[] {
  return db.prepare("SELECT * FROM instruments ORDER BY symbol, exchange").all();
}

export function createInstrument(db: DB, body: Record<string, unknown>): Row {
  const symbol = v.reqStr(body, "symbol", { max: 32 }).toUpperCase();
  const exchange = (v.str(body, "exchange", { optional: true, max: 32 }) ?? "").toUpperCase();
  const existing = db.prepare("SELECT id FROM instruments WHERE symbol = ? AND exchange = ?").get(symbol, exchange);
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
  return getInstrument(db, id);
}
