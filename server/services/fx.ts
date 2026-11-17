/**
 * Exchange rates. The Bank of Canada (keyless, consent required) publishes daily rates against CAD for ~25
 * currencies; any pair through CAD is derived from those. Alpha Vantage is the fallback for currencies the
 * Bank doesn't publish. Rates live in cache.db.
 */
import { type DB, type Row } from "../db/db.ts";
import * as d from "../lib/decimal.ts";
import { isIsoDate } from "../lib/dates.ts";
import {
  allProviders,
  alphaVantageNotice,
  budgetProblem,
  countCall,
  markExhausted,
  providerFetch,
  QuotaExceeded,
  readyProviders,
} from "./providers.ts";

/** Currencies with a daily Bank of Canada series named FX{CODE}CAD. */
export const BOC_CURRENCIES = new Set([
  "AUD",
  "BRL",
  "CNY",
  "EUR",
  "HKD",
  "INR",
  "IDR",
  "JPY",
  "MXN",
  "NZD",
  "NOK",
  "PEN",
  "SAR",
  "SGD",
  "ZAR",
  "KRW",
  "SEK",
  "CHF",
  "TWD",
  "TRY",
  "GBP",
  "USD",
]);

export function storeRate(
  cache: DB,
  base: string,
  quote: string,
  date: string,
  rate: string,
  provider: string,
) {
  cache.prepare(
    `INSERT INTO fx_rates(base, quote, rate_date, rate, provider, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(base, quote, rate_date) DO UPDATE SET rate = excluded.rate, provider = excluded.provider,
       fetched_at = excluded.fetched_at`,
  ).run(base, quote, date, rate, provider, Date.now());
}

function latest(cache: DB, base: string, quote: string): Row | undefined {
  return cache.prepare(
    "SELECT * FROM fx_rates WHERE base = ? AND quote = ? ORDER BY rate_date DESC LIMIT 1",
  ).get(base, quote) as Row | undefined;
}

export interface Rate {
  rate: string;
  date: string;
}

/** 1 `from` = rate `to`. Tries the direct pair, its inverse, then a cross through CAD. */
export function fxRate(cache: DB, from: string, to: string): Rate | undefined {
  if (from === to) return { rate: "1", date: "" };
  const direct = latest(cache, from, to);
  if (direct) return { rate: direct.rate as string, date: direct.rate_date as string };
  const inverse = latest(cache, to, from);
  if (inverse && d.sign(inverse.rate as string) > 0) {
    return { rate: d.div("1", inverse.rate as string, 10), date: inverse.rate_date as string };
  }
  if (from !== "CAD" && to !== "CAD") {
    const a = fxRate(cache, from, "CAD");
    const b = fxRate(cache, to, "CAD");
    if (a && b && d.sign(b.rate) > 0) {
      return { rate: d.div(a.rate, b.rate, 10), date: a.date < b.date ? a.date : b.date };
    }
  }
  return undefined;
}

export function convert(cache: DB, amount: string, from: string, to: string): string | undefined {
  const r = fxRate(cache, from, to);
  return r ? d.mul(amount, r.rate) : undefined;
}

function fetchedToday(cache: DB, base: string, quote: string, utcDay: string): boolean {
  const r = latest(cache, base, quote);
  return !!r && new Date(Number(r.fetched_at)).toISOString().slice(0, 10) === utcDay;
}

export interface FxResult {
  updated: string[];
  missing: { currency: string; error: string }[];
}

/** Make sure every currency in `currencies` can be converted to `base`. */
export async function refreshFx(
  data: DB,
  cache: DB,
  currencies: string[],
  base: string,
  utcDay: string,
  fetchFn: typeof fetch = fetch,
): Promise<FxResult> {
  const result: FxResult = { updated: [], missing: [] };
  const needed = [...new Set(currencies.filter((c) => c !== base))];
  if (!needed.length) return result;

  // 1. Bank of Canada: one request for every series we need (each currency and the base, against CAD).
  const boc = readyProviders(data, "bankofcanada")[0];
  const bocWanted = [...new Set([...needed, base])]
    .filter((c) => c !== "CAD" && BOC_CURRENCIES.has(c) && !fetchedToday(cache, c, "CAD", utcDay));
  if (boc && bocWanted.length && !budgetProblem(cache, boc, utcDay)) {
    try {
      countCall(cache, boc.id, utcDay);
      const series = bocWanted.map((c) => `FX${c}CAD`).join(",");
      const f = providerFetch(boc, fetchFn, `Exchange rates · ${bocWanted.join(", ")}`);
      const res = await f(`https://www.bankofcanada.ca/valet/observations/${series}/json?recent=5`);
      if (!res.ok) throw new Error(`Bank of Canada HTTP ${res.status}`);
      const body = await res.json();
      const obs = Array.isArray(body.observations) ? body.observations as Record<string, unknown>[] : [];
      for (const c of bocWanted) {
        const key = `FX${c}CAD`;
        // Observations are oldest-first; take the newest one that has this series.
        const hit = [...obs].reverse().find((o) => isIsoDate(o.d) && (o[key] as { v?: unknown })?.v);
        const value = hit ? String((hit[key] as { v: unknown }).v).trim() : "";
        if (hit && d.isDecimal(value) && d.sign(value) > 0) {
          storeRate(cache, c, "CAD", hit.d as string, value, "bankofcanada");
          result.updated.push(`${c}/CAD`);
        }
      }
    } catch (err) {
      for (const c of bocWanted) result.missing.push({ currency: c, error: (err as Error).message });
    }
  }

  // 2. Alpha Vantage fallback for anything still unconvertible.
  const av = readyProviders(data, "alphavantage")[0];
  for (const c of needed) {
    if (fxRate(cache, c, base)) {
      result.missing = result.missing.filter((m) => m.currency !== c);
      continue;
    }
    if (!av) {
      if (!result.missing.some((m) => m.currency === c)) {
        const hasBoc = allProviders(data).some((p) => p.type === "bankofcanada");
        result.missing.push({
          currency: c,
          error: boc
            ? "Not published by the Bank of Canada; add Alpha Vantage in Settings → Market data"
            : hasBoc
            ? "The Bank of Canada provider isn't ready (Settings → Market data)"
            : "Add the Bank of Canada in Settings → Market data",
        });
      }
      continue;
    }
    if (budgetProblem(cache, av, utcDay)) {
      result.missing.push({ currency: c, error: `${av.name} daily limit reached; will retry tomorrow` });
      continue;
    }
    try {
      countCall(cache, av.id, utcDay);
      const url = new URL("https://www.alphavantage.co/query");
      url.search = new URLSearchParams({
        function: "CURRENCY_EXCHANGE_RATE",
        from_currency: c,
        to_currency: base,
        apikey: av.apiKey!,
      }).toString();
      const res = await providerFetch(av, fetchFn, `Exchange rate · ${c}/${base}`)(url);
      const body = await res.json();
      const notice = body.Note ?? body.Information;
      if (notice) {
        if (alphaVantageNotice(String(notice)) === "daily") throw new QuotaExceeded(String(notice));
        throw new Error(String(notice));
      }
      const info = body["Realtime Currency Exchange Rate"];
      const rate = String(info?.["5. Exchange Rate"] ?? "").trim();
      const date = String(info?.["6. Last Refreshed"] ?? "").slice(0, 10);
      if (!d.isDecimal(rate) || d.sign(rate) <= 0 || !isIsoDate(date)) throw new Error("No rate returned");
      storeRate(cache, c, base, date, rate, "alphavantage");
      result.updated.push(`${c}/${base}`);
      result.missing = result.missing.filter((m) => m.currency !== c);
    } catch (err) {
      if (err instanceof QuotaExceeded) markExhausted(cache, av.id, utcDay, err.message);
      result.missing = result.missing.filter((m) => m.currency !== c);
      result.missing.push({ currency: c, error: `${av.name}: ${(err as Error).message}` });
    }
  }
  return result;
}

/** Currencies in use: accounts and instruments held. */
export function currenciesInUse(data: DB): string[] {
  return data.prepare(
    `SELECT currency FROM accounts WHERE archived_at IS NULL
     UNION SELECT i.currency FROM instruments i JOIN assets a ON a.instrument_id = i.id WHERE a.archived_at IS NULL`,
  ).all().map((r) => r.currency as string);
}
