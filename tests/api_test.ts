/** End-to-end tests through the HTTP handler with in-memory databases and a fake market-data API. */
import assert from "node:assert/strict";
import { openInMemory } from "../server/db/db.ts";
import { createApp } from "../server/app.ts";
import { evaluateTriggers, queueClaimReviews } from "../server/services/engine.ts";
import { storePrice } from "../server/services/prices.ts";
import { resetLoginBrake } from "../server/services/auth.ts";

// deno-lint-ignore no-explicit-any
type J = Record<string, any>;

function fakeMarket(prices: Record<string, string>, calls: string[]): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.hostname);
    const symbol = url.searchParams.get("symbol")!;
    if (url.hostname === "www.alphavantage.co") {
      if (calls.filter((h) => h === "www.alphavantage.co").length > 1) {
        return Promise.resolve(Response.json({ Information: "You have reached the 25 requests per day rate limit" }));
      }
      return Promise.resolve(Response.json({
        "Time Series (Daily)": { "2026-11-02": { "4. close": prices[symbol] ?? "0" } },
      }));
    }
    return Promise.resolve(Response.json({ c: Number(prices[symbol]), t: Date.UTC(2026, 10, 2) / 1000 }));
  }) as typeof fetch;
}

async function setup(fetchFn?: typeof fetch) {
  resetLoginBrake();
  const dbs = openInMemory();
  const app = createApp({ dbs, fetchFn, kdfIterations: 1000 });
  let token = "";
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: J }> => {
    const res = await app(
      new Request(`http://pfat.test${path}`, {
        method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await call(method, path, body);
    assert.ok(r.status < 300, `${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const s = await call("POST", "/api/setup", {
    passphrase: "correct horse battery staple",
    base_currency: "cad",
    time_zone: "America/Vancouver",
    device_name: "test",
  });
  assert.equal(s.status, 201);
  token = s.body.token;
  return { dbs, call, ok, setToken: (t: string) => (token = t) };
}

Deno.test("auth: setup once, login, reject bad tokens", async () => {
  const { call, setToken } = await setup();
  assert.equal((await call("POST", "/api/setup", { passphrase: "x".repeat(20), base_currency: "CAD", time_zone: "UTC" })).status, 409);
  assert.equal((await call("GET", "/api/dashboard")).status, 200);
  setToken("nope");
  assert.equal((await call("GET", "/api/dashboard")).status, 401);
  assert.equal((await call("POST", "/api/login", { passphrase: "wrong wrong wrong" })).status, 401);
  const login = await call("POST", "/api/login", { passphrase: "correct horse battery staple", device_name: "phone" });
  assert.equal(login.status, 200);
  setToken(login.body.token);
  const sessions = (await call("GET", "/api/sessions")).body as unknown as J[];
  assert.equal(sessions.length, 2);
  await call("POST", "/api/logout");
  assert.equal((await call("GET", "/api/dashboard")).status, 401);
});

Deno.test("trades: sales close specific purchases; theses link per purchase", async () => {
  const { ok, call } = await setup();
  const acct = await ok("POST", "/api/accounts", { name: "TFSA", kind: "self_directed", tags: ["TFSA"] });
  assert.equal(acct.currency, "CAD");
  const aapl = await ok("POST", "/api/instruments", { symbol: "aapl", kind: "equity", currency: "USD" });
  const asset = await ok("POST", "/api/assets", { account_id: acct.id, instrument_id: aapl.id });
  assert.equal(asset.tracking, "trades");

  const b1 = await ok("POST", `/api/assets/${asset.id}/buys`, { trade_date: "2026-01-10", quantity: "10", price: "100" });
  const b2 = await ok("POST", `/api/assets/${asset.id}/buys`, { trade_date: "2026-03-10", quantity: "5", price: "130" });

  const growth = await ok("POST", "/api/theses", { title: "Growth", status: "active" });
  const ai = await ok("POST", "/api/theses", { title: "AI wave", status: "active" });
  await ok("POST", `/api/theses/${growth.id}/links`, { asset_id: asset.id, buy_trade_id: b1.id });
  await ok("POST", `/api/theses/${ai.id}/links`, { asset_id: asset.id, buy_trade_id: b2.id });
  // A purchase may serve more than one thesis.
  await ok("POST", `/api/theses/${ai.id}/links`, { asset_id: asset.id, buy_trade_id: b1.id });
  // Trade-tracked links need a purchase.
  assert.equal((await call("POST", `/api/theses/${growth.id}/links`, { asset_id: asset.id })).status, 400);

  // Allocations must add up and not exceed what is open.
  assert.equal((await call("POST", `/api/assets/${asset.id}/sells`, {
    trade_date: "2026-04-01", quantity: "6", price: "150", allocations: [{ buy_trade_id: b2.id, quantity: "6" }],
  })).status, 400);
  assert.equal((await call("POST", `/api/assets/${asset.id}/sells`, {
    trade_date: "2026-04-01", quantity: "6", price: "150", allocations: [{ buy_trade_id: b2.id, quantity: "5" }],
  })).status, 400);

  const sale = await ok("POST", `/api/assets/${asset.id}/sells`, {
    trade_date: "2026-04-01", quantity: "5", price: "150", allocations: [{ buy_trade_id: b2.id, quantity: "5" }],
  });
  assert.deepEqual(sale.fully_sold_theses, []); // AI wave still holds b1

  const after = await ok("GET", `/api/assets/${asset.id}`);
  assert.equal(after.quantity, "10");
  assert.equal(after.average_cost, "100");
  assert.equal(after.links.length, 3);
});

Deno.test("triggers fire once, notifications need action, adjusting re-arms", async () => {
  const { dbs, ok, call } = await setup();
  const acct = await ok("POST", "/api/accounts", { name: "Margin", kind: "self_directed", currency: "USD" });
  const inst = await ok("POST", "/api/instruments", { symbol: "NVDA", kind: "equity", currency: "USD" });
  const asset = await ok("POST", "/api/assets", { account_id: acct.id, instrument_id: inst.id });
  const buy = await ok("POST", `/api/assets/${asset.id}/buys`, { trade_date: "2026-01-05", quantity: "4", price: "100" });
  const t = await ok("POST", "/api/theses", { title: "AI capex", status: "active" });
  await ok("POST", `/api/theses/${t.id}/links`, { asset_id: asset.id, buy_trade_id: buy.id });
  const stop = await ok("POST", `/api/theses/${t.id}/triggers`, {
    type: "pct_change", params: { direction: "down", percent: "10" }, note: "10% stop",
  });
  await ok("POST", `/api/theses/${t.id}/triggers`, { type: "sell_on_date", params: { date: "2027-01-05" } });

  storePrice(dbs.cache, "NVDA", { date: "2026-11-02", close: "95" }, "USD", "test");
  assert.equal(evaluateTriggers(dbs.data, dbs.cache, "2026-11-03"), 0);

  storePrice(dbs.cache, "NVDA", { date: "2026-11-03", close: "88" }, "USD", "test");
  assert.equal(evaluateTriggers(dbs.data, dbs.cache, "2026-11-03"), 1);
  assert.equal(evaluateTriggers(dbs.data, dbs.cache, "2026-11-04"), 0, "no re-alert while open");
  assert.equal((await ok("GET", `/api/theses/${t.id}`)).status, "triggered");

  const [n] = (await ok("GET", "/api/notifications")) as unknown as J[];
  assert.equal(n.kind, "trigger_fired");
  assert.equal(n.firing.observed.change_pct, "-12");

  // Dismissing needs a reason.
  assert.equal((await call("POST", `/api/notifications/${n.id}/actions`, { action: "dismiss" })).status, 400);

  // Adjust the stop to 20%: resolves the alert as 'adjusted', thesis back to active, revision recorded.
  await ok("PATCH", `/api/triggers/${stop.id}`, {
    params: { direction: "down", percent: "20" }, note: "Volatile; widening the stop",
  });
  assert.equal(((await ok("GET", "/api/notifications")) as unknown as J[]).length, 0);
  assert.equal((await ok("GET", `/api/theses/${t.id}`)).status, "active");
  const history = (await ok("GET", `/api/theses/${t.id}/history`)) as unknown as J[];
  const trigRevs = history.filter((h) => h.entity_id === stop.id);
  assert.equal(trigRevs.length, 2);
  assert.equal(trigRevs[0].note, "Volatile; widening the stop");
  assert.equal(trigRevs[1].data.params.percent, "10");

  // -12% is inside the new 20% stop: nothing fires. -25% does.
  assert.equal(evaluateTriggers(dbs.data, dbs.cache, "2026-11-04"), 0);
  storePrice(dbs.cache, "NVDA", { date: "2026-11-04", close: "75" }, "USD", "test");
  assert.equal(evaluateTriggers(dbs.data, dbs.cache, "2026-11-04"), 1);

  // Snooze hides it until the date; a sale resolves it.
  const [n2] = (await ok("GET", "/api/notifications")) as unknown as J[];
  await ok("POST", `/api/notifications/${n2.id}/actions`, { action: "snooze", until: "2026-11-10" });
  assert.equal(((await ok("GET", "/api/notifications")) as unknown as J[]).length, 0);

  // Date trigger fires on its date.
  assert.equal(evaluateTriggers(dbs.data, dbs.cache, "2027-01-05"), 1);
});

Deno.test("claims come due for review; closing a thesis needs a retrospective", async () => {
  const { dbs, ok, call } = await setup();
  const t = await ok("POST", "/api/theses", { title: "Strong product", status: "active" });
  const claim = await ok("POST", `/api/theses/${t.id}/claims`, { statement: "Margins keep expanding", review_every_days: 30 });
  assert.equal(queueClaimReviews(dbs.data, "2000-01-01"), 0);
  assert.equal(queueClaimReviews(dbs.data, claim.next_review_on), 1);
  assert.equal(queueClaimReviews(dbs.data, claim.next_review_on), 0, "one open review at a time");

  await ok("POST", `/api/claims/${claim.id}/reviews`, { verdict: "weakened", note: "Q3 margins flat" });
  assert.equal(((await ok("GET", "/api/notifications")) as unknown as J[]).length, 0);

  assert.equal((await call("PATCH", `/api/theses/${t.id}`, { status: "closed" })).status, 400);
  const closed = await ok("PATCH", `/api/theses/${t.id}`, {
    status: "closed", retrospective: "Product stayed strong but valuation capped returns", outcome: "partly",
  });
  assert.equal(closed.status, "closed");
  await ok("POST", `/api/theses/${t.id}/reasoning`, { body: "Lesson: watch valuation, not just product." });
});

Deno.test("prices: consent required, quota exhaustion falls back to the next provider", async () => {
  const calls: string[] = [];
  const { ok } = await setup(fakeMarket({ MSFT: "410.5", SHOP: "120.25" }, calls));
  const acct = await ok("POST", "/api/accounts", { name: "RRSP", kind: "self_directed", currency: "USD" });
  for (const symbol of ["MSFT", "SHOP"]) {
    const inst = await ok("POST", "/api/instruments", { symbol, kind: "equity", currency: "USD" });
    const a = await ok("POST", "/api/assets", { account_id: acct.id, instrument_id: inst.id });
    await ok("POST", `/api/assets/${a.id}/buys`, { trade_date: "2026-01-02", quantity: "1", price: "1" });
  }

  await ok("POST", "/api/providers/alphavantage", { api_key: "AV" });
  await ok("POST", "/api/providers/finnhub", { api_key: "FH" });
  let report = await ok("POST", "/api/jobs/run");
  assert.equal(calls.length, 0, "no calls without consent");
  assert.equal(report.prices.failed.length, 2);

  await ok("POST", "/api/providers/alphavantage", { consent: true });
  await ok("POST", "/api/providers/finnhub", { consent: true });
  report = await ok("POST", "/api/jobs/run");
  assert.deepEqual(report.prices.updated.sort(), ["MSFT", "SHOP"]);
  assert.deepEqual(calls, ["www.alphavantage.co", "www.alphavantage.co", "finnhub.io"]);
  const settings = await ok("GET", "/api/settings");
  assert.equal(settings.providers.find((p: J) => p.id === "alphavantage").exhausted_today, true);
});

Deno.test("client is served with types stripped", async () => {
  const dbs = openInMemory();
  const app = createApp({ dbs });
  const res = await app(new Request("http://pfat.test/app.ts"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /javascript/);
  const code = await res.text();
  assert.ok(!/:\s*string\b/.test(code), "type annotations removed");
  assert.equal((await app(new Request("http://pfat.test/../deno.json"))).status, 404);
  assert.equal((await app(new Request("http://pfat.test/theses/123"))).status, 200); // SPA fallback
});
