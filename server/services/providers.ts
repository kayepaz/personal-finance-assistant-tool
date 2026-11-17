/**
 * Market-data providers: the sources PFAT may call for prices and exchange rates. The user keeps a list of
 * configured providers, each one of the built-in types (Alpha Vantage, Finnhub, Bank of Canada) or a custom
 * JSON API, on a free or paid plan. Providers are tried in list order. Nothing is called until the user has
 * agreed to the consent text, which says what is sent and where. Free plans are paced: one call every two
 * seconds per provider.
 */
import { type DB, type Row } from "../db/db.ts";
import { uuidv7 } from "../lib/ids.ts";
import { isDecimal } from "../lib/decimal.ts";
import { isIsoDate } from "../lib/dates.ts";
import { badRequest, notFound } from "../lib/http.ts";
import * as v from "../lib/validate.ts";
import { PURPOSE_HEADER, SECRET_HEADER } from "./netlog.ts";
import { FREE_PLAN_INTERVAL_MS, pacer } from "./pacing.ts";
import { getMarket, MARKETS } from "./markets.ts";

type Obj = Record<string, unknown>;

/** The provider's daily allowance is used up: stop calling it until tomorrow (UTC). */
export class QuotaExceeded extends Error {}
/** The provider asked us to slow down (calls per second/minute): skip it for now, but not for the day. */
export class RateLimited extends Error {}

export interface DailyClose {
  date: string;
  close: string;
  /** Some responses name the asset too (Alpha Vantage crypto); saves a separate lookup. */
  name?: string;
}

/** What a provider needs to know about the thing being priced. */
export interface PriceRequest {
  symbol: string; // provider symbol, e.g. AAPL, SHOP.TRT, BTC, XAU, BINANCE:BTCUSDT
  kind: string; // instrument kind: equity, etf, fund, crypto, metal, other
  currency: string; // the instrument's currency (the market to price crypto/metals in)
  market?: string; // PFAT market id (US, TSX, CRYPTO…); providers skip markets they don't cover
}

export type ProviderTypeId = "alphavantage" | "finnhub" | "bankofcanada" | "custom";
export const PROVIDER_TYPES: readonly ProviderTypeId[] = [
  "alphavantage",
  "finnhub",
  "bankofcanada",
  "custom",
];

/** A custom provider: a JSON API PFAT calls once per symbol. */
export interface CustomConfig {
  /** https URL with placeholders: {symbol} {ticker} {market} {currency} {apikey}. */
  url: string;
  /** Where the price is in the JSON response, as a dotted path: "price", "data.0.close". */
  price_field: string;
  /** Optional path to the price's date (YYYY-MM-DD…, or a Unix time); without it, today's date is used. */
  date_field?: string;
  /** Optional request header carrying the API key instead of (or as well as) {apikey} in the URL. */
  key_header?: string;
  /** PFAT markets this API can price. */
  markets: string[];
}

/** A configured provider, ready to call. */
export interface Provider {
  id: string;
  type: ProviderTypeId;
  name: string;
  plan: "free" | "paid";
  apiKey: string | null;
  dailyLimit: number | null;
  enabled: boolean;
  config: CustomConfig | Record<string, never>;
}

interface TypeInfo {
  label: string;
  uses: string;
  needsKey: "required" | "optional" | "none";
  plans: ("free" | "paid")[];
  /** Default daily call cap by plan; null = none. */
  limits: { free: number | null; paid: number | null };
  help: string;
  signup?: string;
  consent(p: Provider): string;
}

const hostOf = (url: string) => {
  try {
    return new URL(url.replace(/\{[a-z]+\}/g, "x")).host;
  } catch {
    return "(invalid URL)";
  }
};

export const TYPES: Record<ProviderTypeId, TypeInfo> = {
  alphavantage: {
    label: "Alpha Vantage",
    uses:
      "Prices for every listed market, crypto and metals; exchange rates the Bank of Canada doesn't publish",
    needsKey: "required",
    plans: ["free", "paid"],
    limits: { free: 25, paid: null },
    help: "Free plan: 25 calls a day, at least a second apart. Paid plans lift the daily limit.",
    signup: "https://www.alphavantage.co/support/#api-key",
    consent: () =>
      "PFAT will send ticker symbols (for example AAPL) and your Alpha Vantage API key to www.alphavantage.co to fetch daily closing prices and exchange rates. No holdings, quantities or balances are sent.",
  },
  finnhub: {
    label: "Finnhub",
    uses: "Prices for US stocks and exchange-prefixed crypto (e.g. BINANCE:BTCUSDT); company names",
    needsKey: "required",
    plans: ["free", "paid"],
    limits: { free: 1000, paid: null },
    help: "Free plan: US stocks only, 60 calls a minute. Its calls don't use up Alpha Vantage's daily 25.",
    signup: "https://finnhub.io/register",
    consent: () =>
      "PFAT will send ticker symbols (for example AAPL) and your Finnhub API key to finnhub.io to fetch latest prices and company names. No holdings, quantities or balances are sent.",
  },
  bankofcanada: {
    label: "Bank of Canada",
    uses: "Daily exchange rates for about 25 currencies",
    needsKey: "none",
    plans: ["free"],
    limits: { free: 200, paid: null },
    help: "Free and keyless. Publishes rates against the Canadian dollar on business days.",
    consent: () =>
      "PFAT will ask www.bankofcanada.ca for daily exchange rates (for example USD to CAD) for the currencies your accounts and holdings use. Only currency codes are sent; no key, holdings or balances.",
  },
  custom: {
    label: "Custom JSON API",
    uses: "Prices for the markets you choose",
    needsKey: "optional",
    plans: ["free", "paid"],
    limits: { free: null, paid: null },
    help:
      "Any API that returns a price as JSON for one symbol per call. Use {symbol} (e.g. SHOP.TRT), {ticker} (SHOP), {market} (TSX), {currency} and {apikey} in the URL.",
    consent: (p) =>
      `PFAT will send ticker symbols${p.apiKey ? " and the API key you entered" : ""} to ${
        hostOf((p.config as CustomConfig).url ?? "")
      } to fetch prices. No holdings, quantities or balances are sent.`,
  },
};

export const purpose = (id: string) => `market_data:${id}`;

// ---------- consent ----------

export function hasConsent(data: DB, purposeKey: string): boolean {
  return !!data.prepare("SELECT 1 FROM consents WHERE purpose = ? AND revoked_at IS NULL").get(purposeKey);
}

export function setConsent(data: DB, purposeKey: string, description: string, granted: boolean): void {
  if (granted) {
    if (hasConsent(data, purposeKey)) return;
    data.prepare("INSERT INTO consents(id, purpose, description, granted_at) VALUES (?, ?, ?, ?)")
      .run(uuidv7(), purposeKey, description, Date.now());
  } else {
    data.prepare("UPDATE consents SET revoked_at = ? WHERE purpose = ? AND revoked_at IS NULL").run(
      Date.now(),
      purposeKey,
    );
  }
}

// ---------- daily usage (cache.db) ----------

export function usage(
  cache: DB,
  provider: string,
  day: string,
): { calls: number; exhausted: boolean; note: string | null } {
  const r = cache.prepare("SELECT calls, exhausted, note FROM api_usage WHERE provider = ? AND day = ?").get(
    provider,
    day,
  ) as Row | undefined;
  return { calls: Number(r?.calls ?? 0), exhausted: r?.exhausted === 1, note: (r?.note as string) || null };
}

export function countCall(cache: DB, provider: string, day: string, exhausted = false) {
  cache.prepare(
    `INSERT INTO api_usage(provider, day, calls, exhausted) VALUES (?, ?, 1, ?)
     ON CONFLICT(provider, day) DO UPDATE SET calls = calls + 1, exhausted = max(exhausted, excluded.exhausted)`,
  ).run(provider, day, exhausted ? 1 : 0);
}

export function markExhausted(cache: DB, provider: string, day: string, note = "") {
  cache.prepare(
    `INSERT INTO api_usage(provider, day, calls, exhausted, note) VALUES (?, ?, 0, 1, ?)
     ON CONFLICT(provider, day) DO UPDATE SET exhausted = 1, note = excluded.note`,
  ).run(provider, day, note.slice(0, 500));
}

/** Let a provider be called again today (after a mistaken stop, or a plan upgrade). */
export function resumeToday(cache: DB, provider: string, day: string) {
  cache.prepare("UPDATE api_usage SET exhausted = 0, note = NULL WHERE provider = ? AND day = ?").run(
    provider,
    day,
  );
}

/** Why a provider can't take another call today, or null if it can. */
export function budgetProblem(cache: DB, p: Provider, day: string): string | null {
  const u = usage(cache, p.id, day);
  if (u.exhausted || (p.dailyLimit !== null && u.calls >= p.dailyLimit)) {
    return `${p.name} daily limit reached`;
  }
  return null;
}

// ---------- the configured list ----------

function fromRow(r: Row): Provider {
  let config = {};
  try {
    config = JSON.parse((r.config as string) || "{}");
  } catch { /* keep {} */ }
  return {
    id: r.id as string,
    type: r.type as ProviderTypeId,
    name: r.name as string,
    plan: r.plan as "free" | "paid",
    apiKey: (r.api_key as string | null) || null,
    dailyLimit: r.daily_limit === null ? null : Number(r.daily_limit),
    enabled: r.enabled === 1,
    config: config as CustomConfig,
  };
}

export function allProviders(data: DB): Provider[] {
  return data.prepare("SELECT * FROM providers ORDER BY position, created_at").all().map(fromRow);
}

function getProvider(data: DB, id: string): Provider {
  const r = data.prepare("SELECT * FROM providers WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw notFound("Provider not found");
  return fromRow(r);
}

/** Why a provider won't be called, or null if it's ready. */
export function readiness(data: DB, p: Provider): string | null {
  if (!p.enabled) return "switched off";
  if (TYPES[p.type].needsKey === "required" && !p.apiKey) return "needs an API key";
  if (!hasConsent(data, purpose(p.id))) return "waiting for your consent";
  return null;
}

/** Providers that can price instruments, in the order to try them, each with why it isn't ready (if not). */
export function priceProviders(data: DB): { p: Provider; notReady: string | null }[] {
  return allProviders(data)
    .filter((p) => p.type !== "bankofcanada")
    .map((p) => ({ p, notReady: readiness(data, p) }));
}

export function readyProviders(data: DB, type: ProviderTypeId): Provider[] {
  return allProviders(data).filter((p) => p.type === type && !readiness(data, p));
}

/** Settings page view of the list. */
export function listProviders(data: DB, cache: DB, day: string): Row[] {
  return allProviders(data).map((p) => {
    const t = TYPES[p.type];
    const u = usage(cache, p.id, day);
    return {
      id: p.id,
      type: p.type,
      type_label: t.label,
      name: p.name,
      plan: p.plan,
      uses: t.uses,
      needs_key: t.needsKey,
      has_key: !!p.apiKey,
      key_hint: p.apiKey ? `…${p.apiKey.slice(-4)}` : null,
      daily_limit: p.dailyLimit,
      enabled: p.enabled,
      config: p.config,
      pacing: p.plan === "free" ? `One call every ${FREE_PLAN_INTERVAL_MS / 1000} seconds` : "No pacing",
      consent_text: t.consent(p),
      consented: hasConsent(data, purpose(p.id)),
      not_ready: readiness(data, p),
      calls_today: u.calls,
      exhausted_today: u.exhausted,
      // Stopped early (before its own limit) because the provider said so; shows the provider's words.
      exhausted_note: u.exhausted ? u.note : null,
    };
  });
}

/** The provider types, for the Add provider form. */
export function providerTypes(): Row[] {
  return PROVIDER_TYPES.map((id) => {
    const t = TYPES[id];
    return {
      type: id,
      label: t.label,
      uses: t.uses,
      needs_key: t.needsKey,
      plans: t.plans,
      limits: t.limits,
      help: t.help,
      signup: t.signup ?? null,
      // Built-in consent text; the custom one depends on the URL, so the form fills in the host.
      consent_text: id === "custom" ? null : t.consent({} as Provider),
    };
  });
}

function parseCustomConfig(raw: unknown): CustomConfig {
  if (typeof raw !== "object" || raw === null) throw badRequest("'config' is required for a custom provider");
  const c = raw as Obj;
  const url = v.reqStr(c, "url", { max: 500 });
  let parsed: URL;
  try {
    parsed = new URL(url.replace(/\{[a-z]+\}/g, "x"));
  } catch {
    throw badRequest("The URL isn't valid");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw badRequest("The URL must be http(s)");
  }
  if (!/\{(symbol|ticker)\}/.test(url)) throw badRequest("Put {symbol} or {ticker} in the URL");
  const unknown = [...url.matchAll(/\{([a-z]+)\}/g)].map((m) => m[1]).filter((k) =>
    !["symbol", "ticker", "market", "currency", "apikey"].includes(k)
  );
  if (unknown.length) throw badRequest(`Unknown placeholder {${unknown[0]}} in the URL`);
  const path = (k: string, optional: boolean) => {
    const s = v.str(c, k, { optional, max: 200 });
    if (s && !/^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/.test(s)) {
      throw badRequest(`'${k}' must be a dotted path like data.0.close`);
    }
    return s || undefined;
  };
  const markets = v.strArray(c, "markets", { max: 20 }) ?? [];
  if (!markets.length) throw badRequest("Choose at least one market this API covers");
  for (const m of markets) if (!getMarket(m) || m === "OTHER") throw badRequest(`Unknown market '${m}'`);
  const keyHeader = v.str(c, "key_header", { optional: true, max: 100 });
  if (keyHeader && !/^[A-Za-z0-9-]+$/.test(keyHeader)) throw badRequest("'key_header' must be a header name");
  return {
    url,
    price_field: path("price_field", false)!,
    ...(path("date_field", true) ? { date_field: path("date_field", true) } : {}),
    ...(keyHeader ? { key_header: keyHeader } : {}),
    markets,
  };
}

function limitFrom(body: Obj, fallback: number | null): number | null {
  if (!v.has(body, "daily_limit")) return fallback;
  if (body.daily_limit === null || body.daily_limit === "") return null;
  return v.int(body, "daily_limit", { min: 1, max: 1_000_000 })!;
}

export function createProvider(data: DB, body: Obj, id?: string): Provider {
  const type = v.oneOf(body, "type", PROVIDER_TYPES)!;
  const t = TYPES[type];
  const plan = v.oneOf(body, "plan", t.plans, { optional: true }) ?? "free";
  const apiKey = t.needsKey === "none" ? null : v.str(body, "api_key", { optional: true, max: 500 }) || null;
  const config = type === "custom" ? parseCustomConfig(body.config) : {};
  const newId = id ?? uuidv7();
  const position = Number(
    (data.prepare("SELECT coalesce(max(position), 0) + 1 AS n FROM providers").get() as Row).n,
  );
  data.prepare(
    `INSERT INTO providers(id, type, name, plan, api_key, daily_limit, enabled, position, config, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(
    newId,
    type,
    v.str(body, "name", { optional: true, max: 80 }) || t.label,
    plan,
    apiKey,
    limitFrom(body, t.limits[plan]),
    position,
    JSON.stringify(config),
    Date.now(),
  );
  const p = getProvider(data, newId);
  if (v.bool(body, "consent", { optional: true })) setConsent(data, purpose(p.id), t.consent(p), true);
  return p;
}

/**
 * Change a provider. Pointing a custom provider somewhere else revokes consent, because the consent text
 * names the destination. Changing plan resets the daily limit to that plan's default unless one is given.
 */
export function updateProvider(data: DB, id: string, body: Obj): Provider {
  const old = getProvider(data, id);
  const t = TYPES[old.type];
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  const set = (c: string, val: string | number | null) => (sets.push(`${c} = ?`), vals.push(val));
  if (v.has(body, "name")) set("name", v.str(body, "name", { optional: true, max: 80 }) || t.label);
  let plan = old.plan;
  if (v.has(body, "plan")) {
    plan = v.oneOf(body, "plan", t.plans)!;
    set("plan", plan);
  }
  if (v.has(body, "daily_limit")) set("daily_limit", limitFrom(body, null));
  else if (plan !== old.plan) set("daily_limit", t.limits[plan]);
  if (v.has(body, "api_key") && t.needsKey !== "none") {
    set("api_key", v.str(body, "api_key", { optional: true, max: 500 }) || null);
  }
  if (v.has(body, "enabled")) set("enabled", v.bool(body, "enabled") ? 1 : 0);
  if (v.has(body, "config") && old.type === "custom") {
    set("config", JSON.stringify(parseCustomConfig(body.config)));
  }
  if (sets.length) data.prepare(`UPDATE providers SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  const p = getProvider(data, id);
  if (t.consent(p) !== t.consent(old)) setConsent(data, purpose(id), "", false);
  if (v.has(body, "consent")) setConsent(data, purpose(id), t.consent(p), v.bool(body, "consent")!);
  return p;
}

export function moveProvider(data: DB, id: string, direction: "up" | "down"): void {
  const list = allProviders(data);
  const i = list.findIndex((p) => p.id === id);
  if (i < 0) throw notFound("Provider not found");
  const j = direction === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  const upd = data.prepare("UPDATE providers SET position = ? WHERE id = ?");
  list.forEach((p, n) => upd.run(n + 1, p.id));
}

export function deleteProvider(data: DB, id: string): void {
  getProvider(data, id);
  setConsent(data, purpose(id), "", false);
  data.prepare("DELETE FROM providers WHERE id = ?").run(id);
}

/**
 * Quick setup for a built-in type: update the provider with this id, or create it with the type as its id.
 * Kept for scripts and tests (POST /api/providers/alphavantage {api_key, consent}).
 */
export function upsertBuiltin(data: DB, idOrType: string, body: Obj): Provider {
  const exists = data.prepare("SELECT 1 FROM providers WHERE id = ?").get(idOrType);
  if (exists) return updateProvider(data, idOrType, body);
  if (!(PROVIDER_TYPES as readonly string[]).includes(idOrType) || idOrType === "custom") {
    throw notFound("Provider not found");
  }
  return createProvider(data, { ...body, type: idOrType }, idOrType);
}

/** For tests: give a built-in provider an API key, creating it if needed. */
export function setProviderKey(data: DB, type: string, key: string | null): void {
  upsertBuiltin(data, type, { api_key: key ?? "" });
}

// ---------- calling providers ----------

/** A fetch for one provider: paced on free plans, labelled for the communication log, key masked. */
export function providerFetch(p: Provider, fetchFn: typeof fetch, label: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    await pacer.wait(p.id, p.plan === "free" ? FREE_PLAN_INTERVAL_MS : 0);
    const headers = new Headers(init?.headers);
    headers.set(PURPOSE_HEADER, `${label} · ${p.name}`);
    if (p.apiKey) headers.set(SECRET_HEADER, p.apiKey);
    return fetchFn(input, { ...init, headers });
  }) as typeof fetch;
}

const numToDec = (n: unknown): string | null => {
  if (typeof n === "number" && Number.isFinite(n)) return String(n);
  if (typeof n === "string" && isDecimal(n.trim())) return n.trim();
  return null;
};

/**
 * Alpha Vantage answers with a "Note"/"Information" message instead of data. Every one of them mentions premium
 * plans, so tell them apart by what they're about:
 *  - daily allowance ("…standard API rate limit is 25 requests per day…") → stop for today;
 *  - burst ("…spreading out your free API requests more sparingly (1 request per second)…") → slow down;
 *  - anything else (a premium-only endpoint, a bad key…) → this request failed.
 */
export function alphaVantageNotice(msg: string): "daily" | "burst" | "other" {
  // Burst first: its sales pitch can also mention the daily allowance.
  if (/per second|per minute|spreading out|sparingly|call frequency/i.test(msg)) return "burst";
  if (/per day|daily/i.test(msg)) return "daily";
  return "other";
}

/** Fetch an Alpha Vantage URL; on a burst notice, try once more (paced), then report it as rate-limited. */
async function alphaVantageJson(f: typeof fetch, url: URL): Promise<Record<string, unknown>> {
  for (let attempt = 0;; attempt++) {
    const res = await f(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const msg = body.Note ?? body.Information;
    if (!msg) return body;
    const kind = alphaVantageNotice(String(msg));
    if (kind === "daily") throw new QuotaExceeded(String(msg));
    if (kind === "burst") {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, BURST_RETRY_MS));
        continue;
      }
      throw new RateLimited(String(msg));
    }
    throw new Error(String(msg));
  }
}

let BURST_RETRY_MS = 1500;
/** Tests: don't wait before retrying a burst notice. */
export function setBurstRetryMs(ms: number) {
  BURST_RETRY_MS = ms;
}

export function covers(p: Provider, req: PriceRequest): boolean {
  switch (p.type) {
    case "alphavantage":
      return req.market !== "OTHER";
    case "finnhub":
      // Crypto only with exchange-prefixed symbols (e.g. BINANCE:BTCUSDT); no metals; US stocks only.
      return req.kind !== "metal" && (req.kind !== "crypto" || req.symbol.includes(":")) &&
        (!req.market || req.market === "US" || req.market === "CRYPTO");
    case "custom":
      return (p.config as CustomConfig).markets?.includes(req.market ?? "US") ?? false;
    default:
      return false;
  }
}

export async function fetchLatestClose(
  p: Provider,
  req: PriceRequest,
  fetchFn: typeof fetch,
): Promise<DailyClose | null> {
  const f = providerFetch(p, fetchFn, `Price · ${req.symbol}`);
  if (p.type === "alphavantage") return await alphaVantageClose(p, req, f);
  if (p.type === "finnhub") return await finnhubClose(p, req, f);
  if (p.type === "custom") return await customClose(p, req, f);
  return null;
}

export async function lookupName(
  p: Provider,
  req: PriceRequest,
  fetchFn: typeof fetch,
): Promise<string | null> {
  if (req.kind === "crypto" || req.kind === "metal") return null;
  const f = providerFetch(p, fetchFn, `Name · ${req.symbol}`);
  if (p.type === "finnhub") {
    const url = new URL("https://finnhub.io/api/v1/stock/profile2");
    url.search = new URLSearchParams({ symbol: req.symbol, token: p.apiKey! }).toString();
    const res = await f(url);
    if (res.status === 429) throw new RateLimited("Finnhub asked to slow down (calls per minute)");
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
  }
  if (p.type === "alphavantage") {
    // SYMBOL_SEARCH matches on the bare ticker; keep only the exact provider symbol (e.g. SHOP.TRT).
    const url = new URL("https://www.alphavantage.co/query");
    url.search = new URLSearchParams({ function: "SYMBOL_SEARCH", keywords: ticker(req), apikey: p.apiKey! })
      .toString();
    let body: Record<string, unknown>;
    try {
      body = await alphaVantageJson(f, url);
    } catch (err) {
      if (err instanceof QuotaExceeded) throw err;
      return null; // a name is a nice-to-have
    }
    const matches = (body.bestMatches ?? []) as Record<string, string>[];
    const hit = matches.find((m) => String(m["1. symbol"] ?? "").toUpperCase() === req.symbol.toUpperCase());
    return hit?.["2. name"]?.trim() || null;
  }
  return null;
}

/** The symbol without its market suffix: SHOP.TRT → SHOP. */
function ticker(req: PriceRequest): string {
  const suffix = MARKETS.find((m) => m.id === req.market)?.alphaVantageSuffix;
  if (suffix && req.symbol.endsWith(suffix)) return req.symbol.slice(0, -suffix.length);
  return req.symbol.replace(/\.[A-Z]+$/, "");
}

async function alphaVantageClose(
  p: Provider,
  req: PriceRequest,
  f: typeof fetch,
): Promise<DailyClose | null> {
  const url = new URL("https://www.alphavantage.co/query");
  const params: Record<string, string> = req.kind === "crypto"
    ? { function: "DIGITAL_CURRENCY_DAILY", symbol: req.symbol, market: req.currency }
    : req.kind === "metal"
    ? { function: "CURRENCY_EXCHANGE_RATE", from_currency: req.symbol, to_currency: req.currency }
    : { function: "TIME_SERIES_DAILY", symbol: req.symbol };
  url.search = new URLSearchParams({ ...params, apikey: p.apiKey! }).toString();
  // deno-lint-ignore no-explicit-any
  const body: any = await alphaVantageJson(f, url);
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
  if (!close) return null;
  const name = String(body["Meta Data"]?.["3. Digital Currency Name"] ?? "").trim();
  return name ? { date: latest, close, name } : { date: latest, close };
}

async function finnhubClose(p: Provider, req: PriceRequest, f: typeof fetch): Promise<DailyClose | null> {
  const url = new URL("https://finnhub.io/api/v1/quote");
  url.search = new URLSearchParams({ symbol: req.symbol, token: p.apiKey! }).toString();
  const res = await f(url);
  if (res.status === 429) throw new RateLimited("Finnhub asked to slow down (calls per minute)");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const close = numToDec(body.c);
  if (!close || close === "0" || typeof body.t !== "number" || body.t === 0) return null; // unknown symbol
  return { date: new Date(body.t * 1000).toISOString().slice(0, 10), close };
}

/** Follow a dotted path ("data.0.close") into parsed JSON. */
export function pick(body: unknown, path: string): unknown {
  let cur: unknown = body;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function toDate(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString().slice(0, 10);
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (/^\d+$/.test(s)) return toDate(Number(s));
    const day = s.slice(0, 10);
    if (isIsoDate(day)) return day;
  }
  return null;
}

/** Build a custom provider's URL for a request. */
export function customUrl(p: Provider, req: PriceRequest): string {
  const c = p.config as CustomConfig;
  const values: Record<string, string> = {
    symbol: req.symbol,
    ticker: ticker(req),
    market: req.market ?? "US",
    currency: req.currency,
    apikey: p.apiKey ?? "",
  };
  return c.url.replace(/\{([a-z]+)\}/g, (_, k: string) => encodeURIComponent(values[k] ?? ""));
}

async function customClose(p: Provider, req: PriceRequest, f: typeof fetch): Promise<DailyClose | null> {
  const c = p.config as CustomConfig;
  const headers: Record<string, string> = { accept: "application/json" };
  if (c.key_header && p.apiKey) headers[c.key_header] = p.apiKey;
  const res = await f(customUrl(p, req), { headers });
  if (res.status === 429) throw new RateLimited(`${p.name} asked to slow down (HTTP 429)`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error("The response wasn't JSON");
  }
  const close = numToDec(pick(body, c.price_field));
  if (!close || close === "0") return null;
  const date = c.date_field ? toDate(pick(body, c.date_field)) : null;
  if (c.date_field && !date) throw new Error(`No date at '${c.date_field}' in the response`);
  return { date: date ?? new Date().toISOString().slice(0, 10), close };
}

/** Guard used by routes: a provider id must exist. */
export function requireProvider(data: DB, id: string): Provider {
  return getProvider(data, id);
}
