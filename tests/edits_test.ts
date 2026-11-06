/** Price targets, crypto/metal/manual prices, passphrase change, trade/instrument edits, account type changes. */
import assert from "node:assert/strict";
import { openInMemory } from "../server/db/db.ts";
import { createApp } from "../server/app.ts";
import { evaluateTriggers, runJobs } from "../server/services/engine.ts";
import { setConsent, setProviderKey, storePrice } from "../server/services/prices.ts";
import { storeRate } from "../server/services/fx.ts";
import { resetLoginBrake } from "../server/services/auth.ts";

// deno-lint-ignore no-explicit-any
type J = Record<string, any>;
const PASS = "correct horse battery staple";

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
  token =
    (await ok("POST", "/api/setup", { passphrase: PASS, base_currency: "CAD", time_zone: "UTC" })).token;
  return { dbs, call, ok, setToken: (t: string) => (token = t) };
}

async function holding(
  ok: (m: string, p: string, b?: unknown) => Promise<J>,
  symbol: string,
  kind = "equity",
  extra: J = {},
) {
  const acct = await ok("POST", "/api/accounts", {
    name: `${symbol} acct`,
    kind: "self_directed",
    currency: "USD",
  });
  const inst = await ok("POST", "/api/instruments", { symbol, kind, currency: "USD", ...extra });
  const asset = await ok("POST", "/api/assets", { account_id: acct.id, instrument_id: inst.id });
  const buy = await ok("POST", `/api/assets/${asset.id}/buys`, {
    trade_date: "2026-01-02",
    quantity: "10",
    price: "4",
  });
  const thesis = await ok("POST", "/api/theses", { title: `${symbol} thesis`, status: "active" });
  await ok("POST", `/api/theses/${thesis.id}/links`, { asset_id: asset.id, buy_trade_id: buy.id });
  return { acct, inst, asset, buy, thesis };
}

Deno.test("price target fires at or above / at or below a set price", async () => {
  const { dbs, ok, call } = await setup();
  const h = await holding(ok, "PLUG");
  assert.equal(
    (await call("POST", "/api/triggers", { type: "price_target", params: { direction: "up", price: "5" } }))
      .status,
    400,
  );
  await ok("POST", "/api/triggers", {
    thesis_id: h.thesis.id,
    type: "price_target",
    label: "Sell at $5",
    params: { direction: "at_or_above", price: "5" },
  });
  storePrice(dbs.cache, "PLUG", { date: "2026-11-02", close: "4.99" }, "USD", "t");
  assert.equal(evaluateTriggers(dbs.data, dbs.cache, "2026-11-02"), 0);
  storePrice(dbs.cache, "PLUG", { date: "2026-11-03", close: "5.00" }, "USD", "t");
  assert.equal(evaluateTriggers(dbs.data, dbs.cache, "2026-11-03"), 1);
  const [n] = (await ok("GET", "/api/notifications")) as unknown as J[];
  assert.equal(
    n.title,
    "Sell at $5: PLUG acct asset reached 5".replace("PLUG acct asset", n.firing.asset_name),
  );
});

Deno.test("crypto and metals use the right Alpha Vantage calls; manual prices win and are used everywhere", async () => {
  const urls: URL[] = [];
  const fakeFetch = ((input: string | URL) => {
    const url = new URL(String(input));
    urls.push(url);
    const fn = url.searchParams.get("function");
    if (fn === "DIGITAL_CURRENCY_DAILY") {
      return Promise.resolve(Response.json({
        "Time Series (Digital Currency Daily)": { "2026-11-02": { "4. close": "70123.45" } },
      }));
    }
    if (fn === "CURRENCY_EXCHANGE_RATE") {
      return Promise.resolve(Response.json({
        "Realtime Currency Exchange Rate": {
          "5. Exchange Rate": "2650.10",
          "6. Last Refreshed": "2026-11-02 21:00:00",
        },
      }));
    }
    return Promise.resolve(Response.json({ "Error Message": "Invalid API call" }));
  }) as typeof fetch;
  const { dbs, ok } = await setup(fakeFetch);
  setProviderKey(dbs.data, "alphavantage", "AV");
  setConsent(dbs.data, "market_data:alphavantage", "t", true);
  storeRate(dbs.cache, "USD", "CAD", "2026-11-02", "1.4", "t");

  const btc = await holding(ok, "BTC", "crypto");
  const gold = await holding(ok, "XAU", "metal");
  const art = await holding(ok, "PAINTING", "other", { price_source: "manual" });

  const report = await runJobs(dbs, fakeFetch);
  assert.deepEqual(report.prices.updated.sort(), ["BTC", "XAU"], "manual instruments are not fetched");
  assert.equal(urls.find((u) => u.searchParams.get("symbol") === "BTC")!.searchParams.get("market"), "USD");
  assert.equal(
    urls.find((u) => u.searchParams.get("from_currency") === "XAU")!.searchParams.get("to_currency"),
    "USD",
  );

  // A manual price for the painting values it; a newer manual price overrides a fetched one.
  await ok("POST", `/api/instruments/${art.inst.id}/prices`, { price_date: "2026-11-01", close: "1200" });
  await ok("POST", `/api/instruments/${btc.inst.id}/prices`, { price_date: "2026-11-03", close: "71000" });
  const asset = await ok("GET", `/api/assets/${btc.asset.id}`);
  assert.equal(asset.latest_price.close, "71000");
  assert.equal(asset.latest_price.provider, "manual");
  const sheet = (await ok("GET", "/api/reports")).balance_sheet;
  assert.equal(sheet.accounts.find((a: J) => a.id === art.acct.id).value_native, "12000");
  assert.equal(sheet.accounts.find((a: J) => a.id === gold.acct.id).value_native, "26501");

  await ok("DELETE", `/api/instruments/${btc.inst.id}/prices/2026-11-03`);
  assert.equal((await ok("GET", `/api/assets/${btc.asset.id}`)).latest_price.close, "70123.45");
});

Deno.test("changing the passphrase signs out other devices", async () => {
  const { ok, call, setToken } = await setup();
  const other = await ok("POST", "/api/login", { passphrase: PASS, device_name: "phone" });
  assert.equal(
    (await call("POST", "/api/passphrase", { current: "wrong wrong wrong", new: "a brand new passphrase" }))
      .status,
    401,
  );
  assert.equal((await call("POST", "/api/passphrase", { current: PASS, new: "short" })).status, 400);
  await ok("POST", "/api/passphrase", { current: PASS, new: "a brand new passphrase" });
  assert.equal((await call("GET", "/api/dashboard")).status, 200, "this device stays signed in");
  setToken(other.token);
  assert.equal((await call("GET", "/api/dashboard")).status, 401, "other devices are signed out");
  resetLoginBrake();
  assert.equal((await call("POST", "/api/login", { passphrase: PASS })).status, 401);
  assert.equal((await call("POST", "/api/login", { passphrase: "a brand new passphrase" })).status, 200);
});

Deno.test("trades and instruments can be corrected within the rules", async () => {
  const { ok, call } = await setup();
  const h = await holding(ok, "AMD");
  const sale = await ok("POST", `/api/assets/${h.asset.id}/sells`, {
    trade_date: "2026-03-01",
    quantity: "4",
    price: "6",
    allocations: [{ buy_trade_id: h.buy.id, quantity: "4" }],
  });
  await ok("PATCH", `/api/trades/${h.buy.id}`, { price: "4.25", quantity: "12", notes: "fixed typo" });
  assert.equal(
    (await call("PATCH", `/api/trades/${h.buy.id}`, { quantity: "3" })).status,
    400,
    "below sold qty",
  );
  assert.equal(
    (await call("PATCH", `/api/trades/${h.buy.id}`, { trade_date: "2026-04-01" })).status,
    400,
    "after its sale",
  );
  assert.equal(
    (await call("PATCH", `/api/trades/${sale.trade.id}`, { trade_date: "2025-12-31" })).status,
    400,
    "before its buy",
  );
  assert.equal((await call("PATCH", `/api/trades/${sale.trade.id}`, { quantity: "2" })).status, 400);
  await ok("PATCH", `/api/trades/${sale.trade.id}`, { price: "6.5" });
  const a = await ok("GET", `/api/assets/${h.asset.id}`);
  assert.equal(a.quantity, "8");
  assert.equal(a.average_cost, "4.25");

  const other = await ok("POST", "/api/instruments", { symbol: "INTC", kind: "equity", currency: "USD" });
  assert.equal((await call("PATCH", `/api/instruments/${other.id}`, { symbol: "AMD" })).status, 409);
  const edited = await ok("PATCH", `/api/instruments/${h.inst.id}`, {
    name: "Advanced Micro Devices",
    provider_symbol: "AMD.US",
  });
  assert.equal(edited.provider_symbol, "AMD.US");
  assert.equal(edited.name, "Advanced Micro Devices");
});

Deno.test("changing account type keeps the balance history visible", async () => {
  const { dbs, ok } = await setup();
  const managed = await ok("POST", "/api/accounts", { name: "Robo", kind: "managed", currency: "CAD" });
  await ok("POST", `/api/accounts/${managed.id}/snapshots`, { amount: "5000", as_of: "2026-10-01" });
  await ok("PATCH", `/api/accounts/${managed.id}`, { kind: "self_directed" });
  let a = await ok("GET", `/api/accounts/${managed.id}`);
  assert.deepEqual(a.snapshots.map((s: J) => s.kind), ["cash"]);

  // Back to managed: cash entries become values, and today's holdings + cash is recorded.
  const inst = await ok("POST", "/api/instruments", { symbol: "VFV", kind: "etf", currency: "CAD" });
  const asset = await ok("POST", "/api/assets", { account_id: managed.id, instrument_id: inst.id });
  await ok("POST", `/api/assets/${asset.id}/buys`, {
    trade_date: "2026-10-02",
    quantity: "10",
    price: "100",
  });
  storePrice(dbs.cache, "VFV", { date: "2026-11-01", close: "150" }, "CAD", "t");
  await ok("PATCH", `/api/accounts/${managed.id}`, { kind: "managed" });
  a = await ok("GET", `/api/accounts/${managed.id}`);
  assert.deepEqual(a.snapshots.map((s: J) => [s.kind, s.amount]), [["value", "6500"], ["value", "5000"]]);
  const sheet = (await ok("GET", "/api/reports")).balance_sheet;
  assert.equal(sheet.accounts[0].value_base, "6500");
});

Deno.test("storage report counts tables and rows", async () => {
  const { ok } = await setup();
  const r = await ok("GET", "/api/storage");
  const data = r.databases.find((d: J) => d.name === "data");
  assert.ok(data.tables >= 20);
  assert.ok(data.rows >= 3); // settings + session
  assert.ok(data.bytes > 0);
  assert.deepEqual(r.pre_restore, { count: 0, bytes: 0 });
});

Deno.test("history lists the fields each change touched", async () => {
  const { ok } = await setup();
  const t = await ok("POST", "/api/theses", { title: "Draft idea", summary: "v1", status: "draft" });
  await ok("PATCH", `/api/theses/${t.id}`, { summary: "v2 with more detail", note: "clarified" });
  const trig = await ok("POST", "/api/triggers", {
    thesis_id: t.id,
    label: "Stop",
    type: "pct_change",
    params: { direction: "down", percent: "10" },
  });
  await ok("PATCH", `/api/triggers/${trig.id}`, {
    params: { direction: "down", percent: "20" },
    note: "wider",
  });

  const history = (await ok("GET", `/api/theses/${t.id}/history`)) as unknown as J[];
  const summaryEdit = history.find((h) => h.entity_type === "thesis" && h.action === "update")!;
  assert.deepEqual(summaryEdit.changes, [{ field: "summary", before: "v1", after: "v2 with more detail" }]);
  assert.equal(summaryEdit.subject, "Draft idea");

  const trigEdit = history.find((h) => h.entity_type === "trigger" && h.action === "update")!;
  assert.deepEqual(trigEdit.changes.map((c: J) => c.field), ["params"]);
  assert.equal(trigEdit.changes[0].before.percent, "10");
  assert.equal(trigEdit.changes[0].after.percent, "20");
  assert.equal(trigEdit.subject, "Stop");

  const created = history.find((h) => h.entity_type === "thesis" && h.action === "create")!;
  assert.ok(created.changes.every((c: J) => c.before === undefined || !("before" in c)));
  assert.ok(created.changes.some((c: J) => c.field === "title" && c.after === "Draft idea"));
});
