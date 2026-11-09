/** Markets: per-provider symbols, validation, symbol check, and the 0010 upgrade. */
import assert from "node:assert/strict";
import { migrate, openDatabase, openInMemory } from "../server/db/db.ts";
import { createApp } from "../server/app.ts";
import { resetLoginBrake } from "../server/services/auth.ts";
import { canonicalSymbol, providersFor } from "../server/services/markets.ts";
import { runJobs } from "../server/services/engine.ts";

// deno-lint-ignore no-explicit-any
type J = Record<string, any>;

async function setup(fetchFn?: typeof fetch) {
  resetLoginBrake();
  const dbs = openInMemory();
  const app = createApp({ dbs, fetchFn, kdfIterations: 1000 });
  let token = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app(
      new Request(`http://pfat.test${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as J };
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await call(method, path, body);
    assert.ok(r.status < 300, `${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  token = (await ok("POST", "/api/setup", {
    passphrase: "correct horse battery staple",
    base_currency: "CAD",
    time_zone: "UTC",
  }))
    .token;
  return { dbs, call, ok };
}

Deno.test("canonical symbols use Alpha Vantage's exchange codes", () => {
  assert.equal(canonicalSymbol("TSX", "shop"), "SHOP.TRT");
  assert.equal(canonicalSymbol("TSX", "SHOP.TRT"), "SHOP.TRT");
  assert.equal(canonicalSymbol("TSXV", "GPV"), "GPV.TRV");
  assert.equal(canonicalSymbol("LSE", "TSCO"), "TSCO.LON");
  assert.equal(canonicalSymbol("US", "AAPL"), "AAPL");
  assert.deepEqual(providersFor("US", "AAPL"), ["alphavantage", "finnhub"]);
  assert.deepEqual(providersFor("TSX", "SHOP.TRT"), ["alphavantage"]);
  assert.deepEqual(providersFor("CRYPTO", "BINANCE:BTCUSDT"), ["alphavantage", "finnhub"]);
  assert.deepEqual(providersFor("OTHER", "X"), []);
});

Deno.test("instruments take defaults from their market and are validated against it", async () => {
  const { ok, call } = await setup();
  const shop = await ok("POST", "/api/instruments", { market: "TSX", symbol: "shop", name: "Shopify" });
  assert.deepEqual([shop.symbol, shop.provider_symbol, shop.currency, shop.kind, shop.exchange], [
    "SHOP",
    "SHOP.TRT",
    "CAD",
    "equity",
    "TSX",
  ]);
  // The same ticker on another market is a different instrument.
  await ok("POST", "/api/instruments", { market: "US", symbol: "SHOP" });
  assert.equal((await call("POST", "/api/instruments", { market: "TSX", symbol: "SHOP" })).status, 409);
  assert.equal(
    (await call("POST", "/api/instruments", { market: "TSX", symbol: "BTC", kind: "crypto" })).status,
    400,
  );
  assert.equal((await call("POST", "/api/instruments", { market: "METAL", symbol: "GOLD" })).status, 400);
  const gold = await ok("POST", "/api/instruments", { market: "METAL", symbol: "XAU" });
  assert.deepEqual([gold.kind, gold.currency, gold.price_source], ["metal", "USD", "auto"]);
  const art = await ok("POST", "/api/instruments", { market: "OTHER", symbol: "PAINTING" });
  assert.equal(art.price_source, "manual");
  // Advanced override wins; editing the symbol recomputes unless overridden.
  const odd = await ok("POST", "/api/instruments", {
    market: "TSX",
    symbol: "BRK",
    provider_symbol: "BRK-B.TRT",
  });
  assert.equal(odd.provider_symbol, "BRK-B.TRT");
  const moved = await ok("PATCH", `/api/instruments/${shop.id}`, { symbol: "SHOPX" });
  assert.equal(moved.provider_symbol, "SHOPX.TRT");
  const renamed = await ok("PATCH", `/api/instruments/${odd.id}`, { name: "Berkshire" });
  assert.equal(renamed.provider_symbol, "BRK-B.TRT", "a name change keeps the override");
});

Deno.test("an asset is named after its instrument unless given a name", async () => {
  const { ok } = await setup();
  const acct = await ok("POST", "/api/accounts", {
    name: "Brokerage",
    kind: "self_directed",
    currency: "CAD",
  });
  const shop = await ok("POST", "/api/instruments", { market: "TSX", symbol: "SHOP", name: "Shopify Inc" });
  const bare = await ok("POST", "/api/instruments", { market: "US", symbol: "AAPL" });
  const ry = await ok("POST", "/api/instruments", { market: "TSX", symbol: "RY", name: "Royal Bank" });
  const named = await ok("POST", "/api/assets", { account_id: acct.id, instrument_id: shop.id });
  const fallback = await ok("POST", "/api/assets", { account_id: acct.id, instrument_id: bare.id });
  const custom = await ok("POST", "/api/assets", {
    account_id: acct.id,
    instrument_id: ry.id,
    name: "RY (TFSA)",
  });
  assert.deepEqual([named.name, fallback.name, custom.name], ["Shopify Inc", "AAPL", "RY (TFSA)"]);
});

Deno.test("instruments page lists usage and deletes only unused instruments", async () => {
  const { ok, call, dbs } = await setup();
  const acct = await ok("POST", "/api/accounts", {
    name: "Brokerage",
    kind: "self_directed",
    currency: "CAD",
  });
  const shop = await ok("POST", "/api/instruments", { market: "TSX", symbol: "SHOP", name: "Shopify Inc" });
  const art = await ok("POST", "/api/instruments", { market: "OTHER", symbol: "ART" });
  await ok("POST", `/api/instruments/${art.id}/prices`, { close: "1500", price_date: "2026-11-01" });
  dbs.cache.prepare(
    "INSERT INTO daily_prices(provider_symbol, price_date, close, currency, provider, fetched_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("SHOP.TRT", "2026-11-06", "201.30", "CAD", "alphavantage", 0);
  await ok("POST", "/api/assets", { account_id: acct.id, instrument_id: shop.id });

  const list = await ok("GET", "/api/instruments/overview");
  const bySym = Object.fromEntries(list.map((i: J) => [i.symbol, i]));
  assert.deepEqual(bySym.SHOP.assets.map((a: J) => [a.name, a.account_name]), [["Shopify Inc", "Brokerage"]]);
  assert.equal(bySym.SHOP.latest_price.close, "201.30");
  assert.deepEqual([bySym.ART.assets.length, bySym.ART.manual_price_count, bySym.ART.latest_price.provider], [
    0,
    1,
    "manual",
  ]);

  const blocked = await call("DELETE", `/api/instruments/${shop.id}`);
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /Shopify Inc/);

  const gone = await ok("DELETE", `/api/instruments/${art.id}`);
  assert.equal(gone.manual_prices, 1);
  assert.equal((await ok("GET", "/api/instruments/overview")).length, 1);
  assert.equal(dbs.data.prepare("SELECT count(*) AS n FROM manual_prices").get()!.n, 0);
});

Deno.test("check symbol fetches one price; Finnhub is skipped outside the US", async () => {
  const hosts: string[] = [];
  const fakeFetch = ((input: string | URL) => {
    const url = new URL(String(input));
    hosts.push(`${url.hostname} ${url.searchParams.get("symbol")}`);
    if (url.searchParams.get("from_currency") === "XAG") {
      return Promise.resolve(Response.json({
        "Realtime Currency Exchange Rate": {
          "5. Exchange Rate": "44.10",
          "6. Last Refreshed": "2026-11-06 20:00:00",
        },
      }));
    }
    if (url.searchParams.get("function") === "SYMBOL_SEARCH") {
      hosts.push(`search ${url.searchParams.get("keywords")}`);
      return Promise.resolve(Response.json({
        bestMatches: [
          { "1. symbol": "SHOP", "2. name": "Shopify Inc (US listing)" },
          { "1. symbol": "SHOP.TRT", "2. name": "Shopify Inc" },
        ],
      }));
    }
    if (url.hostname === "finnhub.io" && url.pathname.endsWith("/profile2")) {
      return Promise.resolve(Response.json({ name: "Apple Inc" }));
    }
    if (url.hostname === "finnhub.io" && url.searchParams.get("symbol") === "AAPL") {
      return Promise.resolve(Response.json({ c: 270.1, t: 1762473600 }));
    }
    if (url.hostname === "www.alphavantage.co" && url.searchParams.get("symbol") === "SHOP.TRT") {
      return Promise.resolve(
        Response.json({ "Time Series (Daily)": { "2026-11-06": { "4. close": "201.30" } } }),
      );
    }
    if (url.hostname === "www.alphavantage.co") {
      return Promise.resolve(Response.json({ "Error Message": "Invalid API call" }));
    }
    return Promise.resolve(Response.json({ c: 0, t: 0 }));
  }) as typeof fetch;
  const { ok, call } = await setup(fakeFetch);

  const off = await ok("POST", "/api/instruments/check", { market: "TSX", symbol: "SHOP" });
  assert.equal(off.ok, false);
  assert.match(off.tried[0].result, /not switched on/);

  await ok("POST", "/api/providers/alphavantage", { api_key: "AV", consent: true });
  await ok("POST", "/api/providers/finnhub", { api_key: "FH", consent: true });
  const good = await ok("POST", "/api/instruments/check", { market: "TSX", symbol: "SHOP" });
  assert.deepEqual([good.ok, good.provider, good.price, good.provider_symbol, good.name], [
    true,
    "Alpha Vantage",
    "201.30",
    "SHOP.TRT",
    "Shopify Inc",
  ]);
  assert.ok(hosts.includes("search SHOP"), "the name search sends the bare ticker");

  const metal = await ok("POST", "/api/instruments/check", { market: "METAL", symbol: "XAG" });
  assert.equal(metal.name, "Silver");

  // US: Alpha Vantage has no price here, Finnhub prices it and names it (sparing Alpha Vantage's daily calls).
  const searches = hosts.filter((h) => h.startsWith("search")).length;
  const us = await ok("POST", "/api/instruments/check", { market: "US", symbol: "AAPL" });
  assert.deepEqual([us.ok, us.provider, us.name], [true, "Finnhub", "Apple Inc"]);
  assert.equal(hosts.filter((h) => h.startsWith("search")).length, searches, "no Alpha Vantage name search");

  const bad = await ok("POST", "/api/instruments/check", { market: "TSX", symbol: "NOPE" });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.tried.map((t: J) => t.result), [
    "no price for this symbol",
    "doesn't cover this market (free plan)",
  ]);
  assert.ok(
    !hosts.some((h) => h.startsWith("finnhub.io") && !h.endsWith("AAPL")),
    "Finnhub's free plan isn't asked for TSX symbols",
  );
  assert.equal(
    (await call("POST", "/api/instruments/check", { market: "OTHER", symbol: "ART" })).status,
    400,
  );
});

Deno.test("background refresh skips Finnhub for non-US markets", async () => {
  const hosts: string[] = [];
  const fakeFetch = ((input: string | URL) => {
    hosts.push(new URL(String(input)).hostname);
    return Promise.resolve(Response.json({ Information: "rate limit reached for today" }));
  }) as typeof fetch;
  const { dbs, ok } = await setup(fakeFetch);
  await ok("POST", "/api/providers/alphavantage", { api_key: "AV", consent: true });
  await ok("POST", "/api/providers/finnhub", { api_key: "FH", consent: true });
  const acct = await ok("POST", "/api/accounts", { name: "TFSA", kind: "self_directed" });
  const shop = await ok("POST", "/api/instruments", { market: "TSX", symbol: "SHOP" });
  const asset = await ok("POST", "/api/assets", { account_id: acct.id, instrument_id: shop.id });
  await ok("POST", `/api/assets/${asset.id}/buys`, { trade_date: "2026-01-02", quantity: "1", price: "100" });
  const r = await runJobs(dbs, fakeFetch);
  assert.ok(!hosts.includes("finnhub.io"));
  assert.deepEqual(r.prices.deferred, ["SHOP.TRT"]);
});

Deno.test("migration 0010 assigns markets and fixes .TO symbols", () => {
  const db = openDatabase(":memory:");
  db.exec("PRAGMA foreign_keys = OFF");
  const dir = new URL("../server/db/migrations/data/", import.meta.url);
  const files = [...Deno.readDirSync(dir)].map((e) => e.name).filter((n) => n < "0010").sort();
  for (const f of files) db.exec(Deno.readTextFileSync(new URL(f, dir)));
  db.exec(`PRAGMA user_version = ${files.length}; PRAGMA foreign_keys = ON;`);
  db.exec(`
    INSERT INTO instruments(id, symbol, exchange, name, kind, currency, provider_symbol, created_at, price_source) VALUES
      ('i1','SHOP','TSX','','equity','CAD','SHOP.TO',1,'auto'),
      ('i2','GPV.V','','','equity','CAD','GPV.V',1,'auto'),
      ('i3','AAPL','NASDAQ','','equity','USD','AAPL',1,'auto'),
      ('i4','BTC','','','crypto','USD','BTC',1,'auto'),
      ('i5','MAPLE','','','metal','CAD','MAPLE',1,'manual');
  `);
  migrate(db, "data");
  const rows = db.prepare("SELECT id, symbol, market, exchange, provider_symbol FROM instruments ORDER BY id")
    .all()
    .map((r) => [r.symbol, r.market, r.exchange, r.provider_symbol]);
  assert.deepEqual(rows, [
    ["SHOP", "TSX", "TSX", "SHOP.TRT"],
    ["GPV", "TSXV", "TSXV", "GPV.TRV"],
    ["AAPL", "US", "US", "AAPL"],
    ["BTC", "CRYPTO", "CRYPTO", "BTC"],
    ["MAPLE", "OTHER", "OTHER", "MAPLE"],
  ]);
});

Deno.test("account pages and the account list carry current values", async () => {
  const { ok } = await setup();
  const acct = await ok("POST", "/api/accounts", {
    name: "Brokerage",
    kind: "self_directed",
    currency: "CAD",
  });
  await ok("POST", `/api/accounts/${acct.id}/snapshots`, { kind: "cash", amount: "2500" });
  const art = await ok("POST", "/api/instruments", { market: "OTHER", symbol: "ART", currency: "CAD" });
  const asset = await ok("POST", "/api/assets", { account_id: acct.id, instrument_id: art.id });
  await ok("POST", `/api/assets/${asset.id}/buys`, { trade_date: "2026-05-01", quantity: "2", price: "100" });
  await ok("POST", `/api/instruments/${art.id}/prices`, { close: "150.5" });
  const card = await ok("POST", "/api/accounts", { name: "Visa", kind: "cash", currency: "CAD" });
  await ok("POST", `/api/accounts/${card.id}/snapshots`, { kind: "value", amount: "-640.20" });

  const page = await ok("GET", `/api/accounts/${acct.id}`);
  assert.deepEqual(
    [page.valuation.holdings[0].value_account, page.valuation.holdings_native, page.valuation.value_native],
    ["301", "301", "2801"],
  );
  const list = await ok("GET", "/api/accounts");
  assert.deepEqual(list.map((a: J) => [a.name, a.value.native]), [["Brokerage", "2801"], [
    "Visa",
    "-640.2",
  ]]);
});
