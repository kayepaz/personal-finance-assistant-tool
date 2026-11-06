/**
 * Exchange rates. The Bank of Canada (keyless, consent required) publishes daily rates against CAD for ~25
 * currencies; any pair through CAD is derived from those. Alpha Vantage is the fallback for currencies the
 * Bank doesn't publish. Rates live in cache.db.
 */
import { type DB, getSetting, type Row } from "../db/db.ts";
import * as d from "../lib/decimal.ts";
import { isIsoDate } from "../lib/dates.ts";
import { PURPOSE_HEADER } from "./netlog.ts";
import { BANK_OF_CANADA, countCall, hasConsent, QuotaExceeded, usage } from "./prices.ts";

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
  const bocAllowed = hasConsent(data, `market_data:${BANK_OF_CANADA.id}`);
  const bocWanted = [...new Set([...needed, base])]
    .filter((c) => c !== "CAD" && BOC_CURRENCIES.has(c) && !fetchedToday(cache, c, "CAD", utcDay));
  if (
    bocAllowed && bocWanted.length &&
    usage(cache, BANK_OF_CANADA.id, utcDay).calls < BANK_OF_CANADA.dailyLimit
  ) {
    try {
      countCall(cache, BANK_OF_CANADA.id, utcDay);
      const series = bocWanted.map((c) => `FX${c}CAD`).join(",");
      const res = await fetchFn(`https://www.bankofcanada.ca/valet/observations/${series}/json?recent=5`, {
        headers: { [PURPOSE_HEADER]: `Exchange rates · ${bocWanted.join(", ")} · Bank of Canada` },
      });
      if (!res.ok) throw new Error(`Bank of Canada HTTP ${res.status}`);
      const body = await res.json();
      const obs = Array.isArray(body.observations) ? body.observations as Record<string, unknown>[] : [];
      for (const c of bocWanted) {
        const key = `FX${c}CAD`;
        // Observations are oldest-first; take the newest one that has this series.
        const hit = [...obs].reverse().find((o) => isIsoDate(o.d) && (o[key] as { v?: unknown })?.v);
        const value = hit ? String((hit[key] as { v: unknown }).v).trim() : "";
        if (hit && d.isDecimal(value) && d.sign(value) > 0) {
          storeRate(cache, c, "CAD", hit.d as string, value, BANK_OF_CANADA.id);
          result.updated.push(`${c}/CAD`);
        }
      }
    } catch (err) {
      for (const c of bocWanted) result.missing.push({ currency: c, error: (err as Error).message });
    }
  }

  // 2. Alpha Vantage fallback for anything still unconvertible.
  const avKey = getSetting(data, "api_key:alphavantage");
  const avAllowed = !!avKey && hasConsent(data, "market_data:alphavantage");
  for (const c of needed) {
    if (fxRate(cache, c, base)) {
      result.missing = result.missing.filter((m) => m.currency !== c);
      continue;
    }
    if (!avAllowed) {
      if (!result.missing.some((m) => m.currency === c)) {
        result.missing.push({
          currency: c,
          error: bocAllowed
            ? "Not published by the Bank of Canada; add Alpha Vantage in Settings"
            : "Turn on the Bank of Canada in Settings → Market data",
        });
      }
      continue;
    }
    const u = usage(cache, "alphavantage", utcDay);
    if (u.exhausted || u.calls >= 25) {
      result.missing.push({ currency: c, error: "Alpha Vantage daily limit reached; will retry tomorrow" });
      continue;
    }
    try {
      countCall(cache, "alphavantage", utcDay);
      const url = new URL("https://www.alphavantage.co/query");
      url.search = new URLSearchParams({
        function: "CURRENCY_EXCHANGE_RATE",
        from_currency: c,
        to_currency: base,
        apikey: avKey!,
      })
        .toString();
      const res = await fetchFn(url, {
        headers: { [PURPOSE_HEADER]: `Exchange rate · ${c}/${base} · Alpha Vantage` },
      });
      const body = await res.json();
      if (body.Note || body.Information) throw new QuotaExceeded(String(body.Note ?? body.Information));
      const info = body["Realtime Currency Exchange Rate"];
      const rate = String(info?.["5. Exchange Rate"] ?? "").trim();
      const date = String(info?.["6. Last Refreshed"] ?? "").slice(0, 10);
      if (!d.isDecimal(rate) || d.sign(rate) <= 0 || !isIsoDate(date)) throw new Error("No rate returned");
      storeRate(cache, c, base, date, rate, "alphavantage");
      result.updated.push(`${c}/${base}`);
      result.missing = result.missing.filter((m) => m.currency !== c);
    } catch (err) {
      if (err instanceof QuotaExceeded) {
        cache.prepare("UPDATE api_usage SET exhausted = 1 WHERE provider = 'alphavantage' AND day = ?").run(
          utcDay,
        );
      }
      result.missing = result.missing.filter((m) => m.currency !== c);
      result.missing.push({ currency: c, error: `Alpha Vantage: ${(err as Error).message}` });
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
