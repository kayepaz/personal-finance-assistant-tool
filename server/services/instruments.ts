import type { DB, Row } from "../db/db.ts";
import { uuidv7 } from "../lib/ids.ts";
import { badRequest, conflict, notFound } from "../lib/http.ts";
import { canonicalSymbol, defaultMarket, getMarket, type Market, MARKETS, METALS } from "./markets.ts";
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

export interface InstrumentFields {
  market: Market;
  symbol: string;
  kind: string;
  currency: string;
  provider_symbol: string;
  price_source: "auto" | "manual";
}

/**
 * Resolve and validate instrument fields. The market supplies defaults (type, currency, price source) and the
 * provider symbol; `provider_symbol` in the body is an advanced override.
 */
export function resolveFields(body: Record<string, unknown>, current?: Row): InstrumentFields {
  const has = (k: string) => v.has(body, k);
  const kindIn = has("kind")
    ? v.oneOf(body, "kind", INSTRUMENT_KINDS)
    : (current?.kind as string | undefined);
  const sourceIn = has("price_source")
    ? v.oneOf(body, "price_source", ["auto", "manual"] as const)
    : (current?.price_source as "auto" | "manual" | undefined);
  const marketId = has("market")
    ? v.oneOf(body, "market", MARKETS.map((m) => m.id))!
    : (current?.market as string | undefined) ?? defaultMarket(kindIn ?? "equity", sourceIn ?? "auto");
  const market = getMarket(marketId)!;

  const symbol = (has("symbol") ? v.reqStr(body, "symbol", { max: 32 }) : String(current?.symbol ?? ""))
    .toUpperCase();
  if (!symbol) throw badRequest("'symbol' is required");
  const kind = kindIn && (market.kinds.includes(kindIn) || market.id === "OTHER") ? kindIn : market.kinds[0];
  if (kindIn && kind !== kindIn) {
    throw badRequest(`${market.label} doesn't list ${kindIn === "etf" ? "ETFs" : `${kindIn}s`}`);
  }
  if (market.id === "METAL" && !METALS.some((m) => m.code === symbol)) {
    throw badRequest(`Precious metals are ${METALS.map((m) => `${m.code} (${m.name})`).join(", ")}`);
  }
  const currency = has("currency")
    ? v.currency(body, "currency")!
    : (current?.currency as string) ?? market.currency;
  const priceSource = market.priceSource === "manual" ? "manual" : sourceIn ?? "auto";

  const symbolChanged = has("symbol") || has("market");
  const override = has("provider_symbol")
    ? (v.str(body, "provider_symbol", { optional: true, max: 64 }) ?? "")
    : null;
  const providerSymbol = override
    ? override.toUpperCase()
    : override === "" || symbolChanged || !current
    ? canonicalSymbol(market.id, symbol)
    : current.provider_symbol as string;
  return { market, symbol, kind, currency, provider_symbol: providerSymbol, price_source: priceSource };
}

function checkUnique(db: DB, symbol: string, market: string, exceptId?: string) {
  const clash = db.prepare("SELECT id FROM instruments WHERE symbol = ? AND exchange = ? AND id <> ?").get(
    symbol,
    market,
    exceptId ?? "",
  );
  if (clash) throw conflict(`${symbol} on ${getMarket(market)?.label ?? market} already exists`);
}

export function createInstrument(db: DB, body: Record<string, unknown>): Row {
  const f = resolveFields(body);
  checkUnique(db, f.symbol, f.market.id);
  const id = uuidv7();
  db.prepare(
    `INSERT INTO instruments(id, symbol, exchange, market, name, kind, currency, provider_symbol, price_source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    f.symbol,
    f.market.id,
    f.market.id,
    v.str(body, "name", { optional: true, max: 200 }) ?? "",
    f.kind,
    f.currency,
    f.provider_symbol,
    f.price_source,
    Date.now(),
  );
  return getInstrument(db, id);
}

/** Edit an instrument. Symbol + market must stay unique. */
export function updateInstrument(db: DB, id: string, body: Record<string, unknown>): Row {
  const cur = getInstrument(db, id);
  const f = resolveFields(body, cur);
  checkUnique(db, f.symbol, f.market.id, id);
  db.prepare(
    `UPDATE instruments SET symbol = ?, exchange = ?, market = ?, name = ?, kind = ?, currency = ?,
       provider_symbol = ?, price_source = ? WHERE id = ?`,
  ).run(
    f.symbol,
    f.market.id,
    f.market.id,
    v.has(body, "name") ? v.str(body, "name", { optional: true, max: 200 }) ?? "" : cur.name as string,
    f.kind,
    f.currency,
    f.provider_symbol,
    f.price_source,
    id,
  );
  return instrumentDetail(db, id);
}
