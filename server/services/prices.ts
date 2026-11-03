/**
 * Market prices. Providers are tried in order; each tracks a per-day call budget. When no provider can serve a
 * symbol today, the request is deferred and retried on a later run. Only ticker symbols are ever sent.
 */
import { type DB, getSetting, type Row, setSetting } from "../db/db.ts";
import { uuidv7 } from "../lib/ids.ts";
import { isDecimal } from "../lib/decimal.ts";
import { isIsoDate } from "../lib/dates.ts";
import { badRequest } from "../lib/http.ts";

export class QuotaExceeded extends Error {}

export interface DailyClose {
  date: string;
  close: string;
}

export interface PriceProvider {
  id: string;
  name: string;
  dailyLimit: number;
  /** What the consent prompt tells the user. */
  consentText: string;
  fetchLatestClose(symbol: string, apiKey: string, fetchFn: typeof fetch): Promise<DailyClose | null>;
}

const numToDec = (n: unknown): string | null => {
  if (typeof n === "number" && Number.isFinite(n)) return String(n);
  if (typeof n === "string" && isDecimal(n.trim())) return n.trim();
  return null;
};

export const alphaVantage: PriceProvider = {
  id: "alphavantage",
  name: "Alpha Vantage",
  dailyLimit: 25,
  consentText:
    "PFAT will send ticker symbols (for example AAPL) and your Alpha Vantage API key to www.alphavantage.co to fetch daily closing prices. No holdings, quantities or balances are sent.",
  async fetchLatestClose(symbol, apiKey, fetchFn) {
    const url = new URL("https://www.alphavantage.co/query");
    url.search = new URLSearchParams({ function: "TIME_SERIES_DAILY", symbol, apikey: apiKey }).toString();
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`Alpha Vantage HTTP ${res.status}`);
    const body = await res.json();
    if (body.Note || body.Information) {
      const msg = String(body.Note ?? body.Information);
      if (/rate limit|requests per day|call frequency|premium/i.test(msg)) throw new QuotaExceeded(msg);
      throw new Error(msg);
    }
    if (body["Error Message"]) return null; // unknown symbol
    const series = body["Time Series (Daily)"] as Record<string, Record<string, string>> | undefined;
    if (!series) return null;
    const latest = Object.keys(series).sort().at(-1);
    if (!latest || !isIsoDate(latest)) return null;
    const close = numToDec(series[latest]["4. close"]);
    return close ? { date: latest, close } : null;
  },
};

export const finnhub: PriceProvider = {
  id: "finnhub",
  name: "Finnhub",
  dailyLimit: 1000, // Finnhub limits per minute (60); this cap keeps a runaway loop in check.
  consentText:
    "PFAT will send ticker symbols (for example AAPL) and your Finnhub API key to finnhub.io to fetch latest prices. No holdings, quantities or balances are sent.",
  async fetchLatestClose(symbol, apiKey, fetchFn) {
    const url = new URL("https://finnhub.io/api/v1/quote");
    url.search = new URLSearchParams({ symbol, token: apiKey }).toString();
    const res = await fetchFn(url);
    if (res.status === 429) throw new QuotaExceeded("Finnhub rate limit");
    if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
    const body = await res.json();
    const close = numToDec(body.c);
    if (!close || close === "0" || typeof body.t !== "number" || body.t === 0) return null; // unknown symbol
    return { date: new Date(body.t * 1000).toISOString().slice(0, 10), close };
  },
};

export const PROVIDERS: PriceProvider[] = [alphaVantage, finnhub];

// ---------- settings & consent ----------

export function providerStatus(data: DB, cache: DB, day: string): Row[] {
  return PROVIDERS.map((p) => {
    const usage = cache.prepare("SELECT calls, exhausted FROM api_usage WHERE provider = ? AND day = ?").get(
      p.id,
      day,
    ) as
      | Row
      | undefined;
    return {
      id: p.id,
      name: p.name,
      consent_text: p.consentText,
      has_key: !!getSetting(data, `api_key:${p.id}`),
      consented: hasConsent(data, `market_data:${p.id}`),
      daily_limit: p.dailyLimit,
      calls_today: Number(usage?.calls ?? 0),
      exhausted_today: usage?.exhausted === 1,
    };
  });
}

export function setProviderKey(data: DB, providerId: string, key: string | null): void {
  if (!PROVIDERS.some((p) => p.id === providerId)) throw badRequest("Unknown provider");
  if (key) setSetting(data, `api_key:${providerId}`, key);
  else data.prepare("DELETE FROM settings WHERE key = ?").run(`api_key:${providerId}`);
}

export function hasConsent(data: DB, purpose: string): boolean {
  return !!data.prepare("SELECT 1 FROM consents WHERE purpose = ? AND revoked_at IS NULL").get(purpose);
}

export function setConsent(data: DB, purpose: string, description: string, granted: boolean): void {
  if (granted) {
    if (hasConsent(data, purpose)) return;
    data.prepare("INSERT INTO consents(id, purpose, description, granted_at) VALUES (?, ?, ?, ?)")
      .run(uuidv7(), purpose, description, Date.now());
  } else {
    data.prepare("UPDATE consents SET revoked_at = ? WHERE purpose = ? AND revoked_at IS NULL").run(
      Date.now(),
      purpose,
    );
  }
}

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

function usage(cache: DB, provider: string, day: string): { calls: number; exhausted: boolean } {
  const r = cache.prepare("SELECT calls, exhausted FROM api_usage WHERE provider = ? AND day = ?").get(
    provider,
    day,
  ) as
    | Row
    | undefined;
  return { calls: Number(r?.calls ?? 0), exhausted: r?.exhausted === 1 };
}

function countCall(cache: DB, provider: string, day: string, exhausted = false) {
  cache.prepare(
    `INSERT INTO api_usage(provider, day, calls, exhausted) VALUES (?, ?, 1, ?)
     ON CONFLICT(provider, day) DO UPDATE SET calls = calls + 1, exhausted = max(exhausted, excluded.exhausted)`,
  ).run(provider, day, exhausted ? 1 : 0);
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
  instruments: { provider_symbol: string; currency: string }[],
  utcDay: string,
  fetchFn: typeof fetch = fetch,
): Promise<RefreshResult> {
  const result: RefreshResult = { updated: [], deferred: [], failed: [] };
  const usable = PROVIDERS.filter((p) =>
    getSetting(data, `api_key:${p.id}`) && hasConsent(data, `market_data:${p.id}`)
  );
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
    let lastError = "No market-data provider is set up (add an API key and consent in Settings)";
    for (const p of usable) {
      const u = usage(cache, p.id, utcDay);
      if (u.exhausted || u.calls >= p.dailyLimit) {
        lastError = `${p.name} daily limit reached`;
        continue;
      }
      try {
        countCall(cache, p.id, utcDay);
        const close = await p.fetchLatestClose(symbol, getSetting(data, `api_key:${p.id}`)!, fetchFn);
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
          cache.prepare("UPDATE api_usage SET exhausted = 1 WHERE provider = ? AND day = ?").run(
            p.id,
            utcDay,
          );
          lastError = `${p.name}: ${err.message}`;
          continue;
        }
        lastError = `${p.name}: ${(err as Error).message}`;
      }
    }
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
