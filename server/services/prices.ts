/**
 * Market prices. Providers are tried in order; each tracks a per-day call budget. When no provider can serve a
 * symbol today, the request is deferred and retried on a later run. Only ticker symbols are ever sent.
 */
import { type DB, getSetting, type Row, setSetting } from "../db/db.ts";
import { uuidv7 } from "../lib/ids.ts";
import { isDecimal } from "../lib/decimal.ts";
import { isIsoDate } from "../lib/dates.ts";
import { badRequest } from "../lib/http.ts";
import { PURPOSE_HEADER } from "./netlog.ts";

export class QuotaExceeded extends Error {}

export interface DailyClose {
  date: string;
  close: string;
}

/** What a provider needs to know about the thing being priced. */
export interface PriceRequest {
  symbol: string; // provider symbol, e.g. AAPL, SHOP.TO, BTC, XAU, BINANCE:BTCUSDT
  kind: string; // instrument kind: equity, etf, fund, crypto, metal, other
  currency: string; // the instrument's currency (the market to price crypto/metals in)
  market?: string; // PFAT market id (US, TSX, CRYPTO…); providers skip markets they don't cover
}

export interface PriceProvider {
  id: string;
  name: string;
  dailyLimit: number;
  /** What the consent prompt tells the user. */
  consentText: string;
  /** Whether this provider can price the request at all (checked before using a call from the daily limit). */
  covers(req: PriceRequest): boolean;
  fetchLatestClose(req: PriceRequest, apiKey: string, fetchFn: typeof fetch): Promise<DailyClose | null>;
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
  covers: (req) => req.market !== "OTHER",
  async fetchLatestClose(req, apiKey, fetchFn) {
    const url = new URL("https://www.alphavantage.co/query");
    const params: Record<string, string> = req.kind === "crypto"
      ? { function: "DIGITAL_CURRENCY_DAILY", symbol: req.symbol, market: req.currency }
      : req.kind === "metal"
      ? { function: "CURRENCY_EXCHANGE_RATE", from_currency: req.symbol, to_currency: req.currency }
      : { function: "TIME_SERIES_DAILY", symbol: req.symbol };
    url.search = new URLSearchParams({ ...params, apikey: apiKey }).toString();
    const res = await fetchFn(url, {
      headers: { [PURPOSE_HEADER]: `Price · ${req.symbol} · Alpha Vantage` },
    });
    if (!res.ok) throw new Error(`Alpha Vantage HTTP ${res.status}`);
    const body = await res.json();
    if (body.Note || body.Information) {
      const msg = String(body.Note ?? body.Information);
      if (/rate limit|requests per day|call frequency|premium/i.test(msg)) throw new QuotaExceeded(msg);
      throw new Error(msg);
    }
    if (body["Error Message"]) return null; // unknown symbol
    if (req.kind === "metal") {
      // Spot price per troy ounce, as an exchange rate (e.g. XAU -> USD).
      const info = body["Realtime Currency Exchange Rate"];
      const close = numToDec(String(info?.["5. Exchange Rate"] ?? "").trim());
      const date = String(info?.["6. Last Refreshed"] ?? "").slice(0, 10);
      return close && isIsoDate(date) ? { date, close } : null;
    }
    const series = (body["Time Series (Daily)"] ?? body["Time Series (Digital Currency Daily)"]) as
      | Record<string, Record<string, string>>
      | undefined;
    if (!series) return null;
    const latest = Object.keys(series).sort().at(-1);
    if (!latest || !isIsoDate(latest)) return null;
    const day = series[latest];
    // Crypto responses have used both "4. close" and "4a. close (USD)".
    const closeKey = Object.keys(day).find((k) => /^4a?\. close/.test(k));
    const close = closeKey ? numToDec(day[closeKey]) : null;
    return close ? { date: latest, close } : null;
  },
};

export const finnhub: PriceProvider = {
  id: "finnhub",
  name: "Finnhub",
  dailyLimit: 1000, // Finnhub limits per minute (60); this cap keeps a runaway loop in check.
  consentText:
    "PFAT will send ticker symbols (for example AAPL) and your Finnhub API key to finnhub.io to fetch latest prices. No holdings, quantities or balances are sent.",
  // Crypto only with exchange-prefixed symbols (e.g. BINANCE:BTCUSDT); no metals; the free plan quotes US stocks only.
  covers: (req) =>
    req.kind !== "metal" && (req.kind !== "crypto" || req.symbol.includes(":")) &&
    (!req.market || req.market === "US" || req.market === "CRYPTO"),
  async fetchLatestClose(req, apiKey, fetchFn) {
    const url = new URL("https://finnhub.io/api/v1/quote");
    url.search = new URLSearchParams({ symbol: req.symbol, token: apiKey }).toString();
    const res = await fetchFn(url, { headers: { [PURPOSE_HEADER]: `Price · ${req.symbol} · Finnhub` } });
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

/** Bank of Canada Valet: free, keyless daily exchange rates against CAD. */
export const BANK_OF_CANADA = {
  id: "bankofcanada",
  name: "Bank of Canada",
  dailyLimit: 200,
  consentText:
    "PFAT will ask www.bankofcanada.ca for daily exchange rates (for example USD to CAD) for the currencies your accounts and holdings use. Only currency codes are sent; no key, holdings or balances.",
};

/** Every outbound market-data source, for the Settings page. */
export function providerStatus(data: DB, cache: DB, day: string): Row[] {
  const list = [
    ...PROVIDERS.map((p) => ({
      ...p,
      needs_key: true,
      uses: p.id === "alphavantage" ? "Prices; exchange rates the Bank of Canada doesn't publish" : "Prices",
    })),
    { ...BANK_OF_CANADA, needs_key: false, uses: "Exchange rates" },
  ];
  return list.map((p) => {
    const u = usage(cache, p.id, day);
    return {
      id: p.id,
      name: p.name,
      uses: p.uses,
      needs_key: p.needs_key,
      consent_text: p.consentText,
      has_key: p.needs_key ? !!getSetting(data, `api_key:${p.id}`) : true,
      consented: hasConsent(data, `market_data:${p.id}`),
      daily_limit: p.dailyLimit,
      calls_today: u.calls,
      exhausted_today: u.exhausted,
    };
  });
}

export function findProvider(id: string): { id: string; consentText: string; needsKey: boolean } | undefined {
  if (id === BANK_OF_CANADA.id) return { ...BANK_OF_CANADA, needsKey: false };
  const p = PROVIDERS.find((x) => x.id === id);
  return p ? { ...p, needsKey: true } : undefined;
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

export function usage(cache: DB, provider: string, day: string): { calls: number; exhausted: boolean } {
  const r = cache.prepare("SELECT calls, exhausted FROM api_usage WHERE provider = ? AND day = ?").get(
    provider,
    day,
  ) as
    | Row
    | undefined;
  return { calls: Number(r?.calls ?? 0), exhausted: r?.exhausted === 1 };
}

export function countCall(cache: DB, provider: string, day: string, exhausted = false) {
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
  instruments: { provider_symbol: string; currency: string; kind?: string; market?: string }[],
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
    const req: PriceRequest = {
      symbol,
      kind: inst.kind ?? "equity",
      currency: inst.currency,
      market: inst.market,
    };
    for (const p of usable) {
      if (!p.covers(req)) continue;
      const u = usage(cache, p.id, utcDay);
      if (u.exhausted || u.calls >= p.dailyLimit) {
        lastError = `${p.name} daily limit reached`;
        continue;
      }
      try {
        countCall(cache, p.id, utcDay);
        const close = await p.fetchLatestClose(req, getSetting(data, `api_key:${p.id}`)!, fetchFn);
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
  tried: { provider: string; result: string }[];
}

/**
 * Try to fetch one price for a symbol right away, using the providers that are switched on (in order). Each
 * attempt counts against that provider's daily limit and appears in the communication log. A price found is
 * cached, so the instrument has a price as soon as it's saved.
 */
export async function checkSymbol(
  data: DB,
  cache: DB,
  req: PriceRequest,
  utcDay: string,
  fetchFn: typeof fetch,
): Promise<CheckResult> {
  const result: CheckResult = { ok: false, provider_symbol: req.symbol, tried: [] };
  for (const p of PROVIDERS) {
    if (!p.covers(req)) {
      result.tried.push({ provider: p.name, result: "doesn't cover this market (free plan)" });
      continue;
    }
    const key = getSetting(data, `api_key:${p.id}`);
    if (!key || !hasConsent(data, `market_data:${p.id}`)) {
      result.tried.push({ provider: p.name, result: "not switched on (Settings → Market data)" });
      continue;
    }
    const u = usage(cache, p.id, utcDay);
    if (u.exhausted || u.calls >= p.dailyLimit) {
      result.tried.push({ provider: p.name, result: "daily limit reached" });
      continue;
    }
    try {
      countCall(cache, p.id, utcDay);
      const close = await p.fetchLatestClose(req, key, fetchFn);
      if (!close) {
        result.tried.push({ provider: p.name, result: "no price for this symbol" });
        continue;
      }
      storePrice(cache, req.symbol, close, req.currency, p.id);
      return { ...result, ok: true, provider: p.name, price: close.close, date: close.date };
    } catch (err) {
      if (err instanceof QuotaExceeded) {
        cache.prepare("UPDATE api_usage SET exhausted = 1 WHERE provider = ? AND day = ?").run(p.id, utcDay);
      }
      result.tried.push({ provider: p.name, result: (err as Error).message });
    }
  }
  return result;
}
