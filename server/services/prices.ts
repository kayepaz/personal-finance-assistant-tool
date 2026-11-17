/**
 * Market prices. Providers are tried in order; each tracks a per-day call budget. When no provider can serve a
 * symbol today, the request is deferred and retried on a later run. Only ticker symbols are ever sent.
 */
import { type DB, type Row } from "../db/db.ts";
import { uuidv7 } from "../lib/ids.ts";
import { METALS } from "./markets.ts";
import {
  budgetProblem,
  countCall,
  covers,
  type DailyClose,
  fetchLatestClose,
  lookupName as providerName,
  markExhausted,
  priceProviders,
  type PriceRequest,
  QuotaExceeded,
  RateLimited,
} from "./providers.ts";

export {
  countCall,
  type DailyClose,
  hasConsent,
  type PriceRequest,
  QuotaExceeded,
  setConsent,
  setProviderKey,
  usage,
} from "./providers.ts";

// ---------- cache ----------

export function latestPrice(cache: DB, providerSymbol: string): Row | undefined {
  return cache.prepare(
    "SELECT * FROM daily_prices WHERE provider_symbol = ? ORDER BY price_date DESC LIMIT 1",
  ).get(providerSymbol) as Row | undefined;
}

export function storePrice(cache: DB, symbol: string, close: DailyClose, currency: string, provider: string) {
  cache.prepare(
    `INSERT INTO daily_prices(provider_symbol, price_date, close, currency, provider, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider_symbol, price_date) DO UPDATE SET close = excluded.close, provider = excluded.provider,
       fetched_at = excluded.fetched_at`,
  ).run(symbol, close.date, close.close, currency, provider, Date.now());
}

function defer(cache: DB, symbol: string, error: string) {
  cache.prepare(
    `INSERT INTO deferred_requests(id, kind, key, first_deferred, attempts, last_error)
     VALUES (?, 'daily_price', ?, ?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1, last_error = excluded.last_error`,
  ).run(uuidv7(), symbol, Date.now(), error);
}

export interface RefreshResult {
  updated: string[];
  deferred: string[];
  failed: { symbol: string; error: string }[];
}

/**
 * Fetch the latest close for each instrument not already fetched today. `utcDay` (YYYY-MM-DD, UTC) keys the
 * provider budgets, since free-tier limits reset on UTC days.
 */
export async function refreshPrices(
  data: DB,
  cache: DB,
  instruments: { provider_symbol: string; currency: string; kind?: string; market?: string }[],
  utcDay: string,
  fetchFn: typeof fetch = fetch,
): Promise<RefreshResult> {
  const result: RefreshResult = { updated: [], deferred: [], failed: [] };
  const usable = priceProviders(data).filter((x) => !x.notReady).map((x) => x.p);
  const seen = new Set<string>();

  for (const inst of instruments) {
    const symbol = inst.provider_symbol;
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    const cached = latestPrice(cache, symbol);
    // Already fetched today? Skip.
    if (
      cached && Number(cached.fetched_at) > 0 &&
      new Date(Number(cached.fetched_at)).toISOString().slice(0, 10) === utcDay
    ) {
      continue;
    }

    let done = false;
    let lastError = "No market-data provider is set up (Settings → Market data)";
    const req: PriceRequest = {
      symbol,
      kind: inst.kind ?? "equity",
      currency: inst.currency,
      market: inst.market,
    };
    let anyCovers = false;
    for (const p of usable) {
      if (!covers(p, req)) continue;
      anyCovers = true;
      const over = budgetProblem(cache, p, utcDay);
      if (over) {
        lastError = over;
        continue;
      }
      try {
        countCall(cache, p.id, utcDay);
        const close = await fetchLatestClose(p, req, fetchFn);
        if (!close) {
          lastError = `${p.name} has no price for ${symbol}`;
          continue;
        }
        storePrice(cache, symbol, close, inst.currency, p.id);
        cache.prepare("DELETE FROM deferred_requests WHERE key = ?").run(symbol);
        result.updated.push(symbol);
        done = true;
        break;
      } catch (err) {
        if (err instanceof QuotaExceeded) {
          markExhausted(cache, p.id, utcDay, err.message);
          lastError = `${p.name} daily limit reached: ${err.message}`;
          continue;
        }
        if (err instanceof RateLimited) {
          // Busy, not out for the day: try the next provider, and retry this symbol on the next run.
          lastError = `${p.name} rate limit (too many calls at once); will retry`;
          continue;
        }
        lastError = `${p.name}: ${(err as Error).message}`;
      }
    }
    if (usable.length && !anyCovers) lastError = "None of your providers covers this market";
    if (!done) {
      if (usable.length && /limit/i.test(lastError)) {
        defer(cache, symbol, lastError);
        result.deferred.push(symbol);
      } else {
        result.failed.push({ symbol, error: lastError });
      }
    }
  }
  return result;
}

export function listDeferred(cache: DB): Row[] {
  return cache.prepare("SELECT * FROM deferred_requests ORDER BY first_deferred").all();
}

// ---------- manual prices & combined lookups ----------

/**
 * The newest known close for a provider symbol, from fetched prices (cache.db) or prices the user recorded
 * (data.db). A manual price wins a tie on the same date.
 */
export function currentPrice(data: DB, cache: DB, symbol: string): Row | undefined {
  const fetched = latestPrice(cache, symbol);
  const manual = data.prepare(
    `SELECT m.price_date, m.close, 'manual' AS provider FROM manual_prices m
     JOIN instruments i ON i.id = m.instrument_id WHERE i.provider_symbol = ?
     ORDER BY m.price_date DESC, m.created_at DESC LIMIT 1`,
  ).get(symbol) as Row | undefined;
  if (!manual) return fetched;
  if (!fetched) return manual;
  return (manual.price_date as string) >= (fetched.price_date as string) ? manual : fetched;
}

/** All known closes for a symbol on or after `start`, fetched and manual. */
export function closesSince(data: DB, cache: DB, symbol: string, start: string): Row[] {
  const fetched = cache.prepare(
    "SELECT price_date, close FROM daily_prices WHERE provider_symbol = ? AND price_date >= ?",
  ).all(symbol, start);
  const manual = data.prepare(
    `SELECT m.price_date, m.close FROM manual_prices m JOIN instruments i ON i.id = m.instrument_id
     WHERE i.provider_symbol = ? AND m.price_date >= ?`,
  ).all(symbol, start);
  return [...fetched, ...manual];
}

// ---------- check a symbol before saving ----------

export interface CheckResult {
  ok: boolean;
  provider_symbol: string;
  provider?: string;
  price?: string;
  date?: string;
  /** Suggested name for the form; absent when no provider could name it. */
  name?: string;
  tried: { provider: string; result: string }[];
}

/**
 * Ask the ready providers for a symbol's name, Finnhub first (its limit is per minute, so it doesn't use one of
 * Alpha Vantage's 25 daily calls). Best effort: failures just leave the name blank.
 */
async function lookupName(
  data: DB,
  cache: DB,
  req: PriceRequest,
  utcDay: string,
  fetchFn: typeof fetch,
): Promise<string | null> {
  if (req.kind === "metal") return METALS.find((m) => m.code === req.symbol)?.name ?? null;
  const ready = priceProviders(data).filter((x) => !x.notReady).map((x) => x.p);
  const order = [
    ...ready.filter((p) => p.type === "finnhub"),
    ...ready.filter((p) => p.type === "alphavantage"),
  ];
  for (const p of order) {
    if (!covers(p, req) || budgetProblem(cache, p, utcDay)) continue;
    try {
      countCall(cache, p.id, utcDay);
      const name = await providerName(p, req, fetchFn);
      if (name) return name;
    } catch (err) {
      if (err instanceof QuotaExceeded) markExhausted(cache, p.id, utcDay, err.message);
    }
  }
  return null;
}

/**
 * Try to fetch one price for a symbol right away, using the configured providers in order. Each attempt counts
 * against that provider's daily limit and appears in the communication log. A price found is cached, so the
 * instrument has a price as soon as it's saved.
 */
export async function checkSymbol(
  data: DB,
  cache: DB,
  req: PriceRequest,
  utcDay: string,
  fetchFn: typeof fetch,
): Promise<CheckResult> {
  const result: CheckResult = { ok: false, provider_symbol: req.symbol, tried: [] };
  const list = priceProviders(data);
  if (!list.length) {
    result.tried.push({
      provider: "Settings",
      result: "no price providers set up yet (Settings → Market data)",
    });
  }
  for (const { p, notReady } of list) {
    if (!covers(p, req)) {
      result.tried.push({ provider: p.name, result: "doesn't cover this market" });
      continue;
    }
    if (notReady) {
      result.tried.push({ provider: p.name, result: `${notReady} (Settings → Market data)` });
      continue;
    }
    const over = budgetProblem(cache, p, utcDay);
    if (over) {
      result.tried.push({ provider: p.name, result: "daily limit reached" });
      continue;
    }
    try {
      countCall(cache, p.id, utcDay);
      const close = await fetchLatestClose(p, req, fetchFn);
      if (!close) {
        result.tried.push({ provider: p.name, result: "no price for this symbol" });
        continue;
      }
      storePrice(cache, req.symbol, close, req.currency, p.id);
      const name = close.name ?? await lookupName(data, cache, req, utcDay, fetchFn);
      return {
        ...result,
        ok: true,
        provider: p.name,
        price: close.close,
        date: close.date,
        ...(name ? { name } : {}),
      };
    } catch (err) {
      if (err instanceof QuotaExceeded) markExhausted(cache, p.id, utcDay, err.message);
      result.tried.push({ provider: p.name, result: (err as Error).message });
    }
  }
  return result;
}
