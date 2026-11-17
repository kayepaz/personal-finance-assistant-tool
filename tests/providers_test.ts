/** Configurable market-data providers: the list, consent, custom JSON APIs, and pacing on free plans. */
import assert from "node:assert/strict";
import { migrate, openDatabase, openInMemory } from "../server/db/db.ts";
import { createApp } from "../server/app.ts";
import { resetLoginBrake } from "../server/services/auth.ts";
import { createPacer } from "../server/services/pacing.ts";

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
  })).token;
  return { dbs, call, ok };
}

const CUSTOM = {
  type: "custom",
  name: "My quotes",
  plan: "paid",
  api_key: "sk_live_custom_123",
  config: {
    url: "https://quotes.example.com/v1/{ticker}?market={market}&key={apikey}",
    price_field: "data.0.last",
    date_field: "data.0.ts",
    markets: ["TSX", "US"],
  },
};

Deno.test("providers: add, consent, reorder, change plan, delete", async () => {
  const { ok, call } = await setup();
  const types = (await ok("GET", "/api/settings")).provider_types as J[];
  assert.deepEqual(types.map((t) => t.type), ["alphavantage", "finnhub", "bankofcanada", "custom"]);
  assert.deepEqual((await ok("GET", "/api/settings")).providers, [], "a new install has none configured");

  const av = await ok("POST", "/api/providers", { type: "alphavantage", api_key: "AVKEY", consent: true });
  assert.deepEqual([av.name, av.plan, av.daily_limit, av.consented, av.not_ready, av.key_hint], [
    "Alpha Vantage",
    "free",
    25,
    true,
    null,
    "…VKEY",
  ]);
  assert.match(av.pacing, /every 2 seconds/);

  // Validation for custom APIs.
  const bad = (config: J) =>
    call("POST", "/api/providers", { ...CUSTOM, config: { ...CUSTOM.config, ...config } });
  assert.equal((await bad({ url: "ftp://x.example.com/{symbol}" })).status, 400);
  assert.match((await bad({ url: "https://x.example.com/quote" })).body.error, /\{symbol\} or \{ticker\}/);
  assert.match((await bad({ url: "https://x.example.com/{symbol}/{foo}" })).body.error, /\{foo\}/);
  assert.equal((await bad({ price_field: "data[0]" })).status, 400);
  assert.equal((await bad({ markets: [] })).status, 400);

  const custom = await ok("POST", "/api/providers", { ...CUSTOM, consent: true });
  assert.match(custom.consent_text, /quotes\.example\.com/);
  assert.deepEqual([custom.plan, custom.daily_limit, custom.pacing], ["paid", null, "No pacing"]);

  // Order: move the custom API ahead of Alpha Vantage.
  const order = await ok("POST", `/api/providers/${custom.id}/move`, { direction: "up" });
  assert.deepEqual(order.map((p: J) => p.name), ["My quotes", "Alpha Vantage"]);

  // Pointing the custom API at another host withdraws consent; the new text names the new host.
  const moved = await ok("PATCH", `/api/providers/${custom.id}`, {
    config: { ...CUSTOM.config, url: "https://other.example.net/{symbol}" },
  });
  assert.deepEqual([moved.consented, moved.not_ready], [false, "waiting for your consent"]);
  assert.match(moved.consent_text, /other\.example\.net/);

  // Switching Alpha Vantage to a paid plan lifts the daily cap and the pacing.
  const paid = await ok("PATCH", `/api/providers/${av.id}`, { plan: "paid" });
  assert.deepEqual([paid.daily_limit, paid.pacing, paid.consented], [null, "No pacing", true]);
  assert.equal((await call("PATCH", `/api/providers/${av.id}`, { plan: "gold" })).status, 400);
  const boc = await ok("POST", "/api/providers", { type: "bankofcanada" });
  assert.equal(
    (await call("PATCH", `/api/providers/${boc.id}`, { plan: "paid" })).status,
    400,
    "BoC is free",
  );

  await ok("DELETE", `/api/providers/${av.id}`);
  const left = (await ok("GET", "/api/settings")).providers as J[];
  assert.deepEqual(left.map((p) => p.name), ["My quotes", "Bank of Canada"]);
});

Deno.test("a custom JSON API prices instruments; its key is masked in the log", async () => {
  const urls: string[] = [];
  const fakeFetch = ((input: string | URL) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    if (url.hostname === "quotes.example.com" && url.pathname.endsWith("/SHOP")) {
      return Promise.resolve(Response.json({ data: [{ last: "201.30", ts: 1762473600 }] }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
  const { ok } = await setup(fakeFetch);
  await ok("POST", "/api/providers", { ...CUSTOM, consent: true });

  const checked = await ok("POST", "/api/instruments/check", { market: "TSX", symbol: "SHOP" });
  assert.deepEqual([checked.ok, checked.provider, checked.price, checked.date], [
    true,
    "My quotes",
    "201.30",
    "2025-11-07",
  ]);
  assert.equal(urls[0], "https://quotes.example.com/v1/SHOP?market=TSX&key=sk_live_custom_123");

  const missing = await ok("POST", "/api/instruments/check", { market: "TSX", symbol: "NOPE" });
  assert.deepEqual(missing.tried, [{ provider: "My quotes", result: "no price for this symbol" }]);
  const other = await ok("POST", "/api/instruments/check", { market: "LSE", symbol: "VOD" });
  assert.deepEqual(other.tried, [{ provider: "My quotes", result: "doesn't cover this market" }]);

  const log = (await ok("GET", "/api/network-log")) as unknown as J[];
  assert.ok(log.length >= 2);
  for (const row of log) {
    assert.ok(!JSON.stringify(row).includes("sk_live_custom_123"), "key never stored in the log");
    assert.match(row.purpose, /My quotes/);
  }

  const markets = await ok("GET", "/api/markets");
  assert.deepEqual(markets.providers, [{
    name: "My quotes",
    ready: true,
    markets: ["US", "TSX"],
    crypto_needs_exchange_prefix: false,
  }]);
});

Deno.test("free plans space calls two seconds apart per provider", async () => {
  let clock = 0;
  const slept: number[] = [];
  const pacer = createPacer(() => clock, (ms) => {
    slept.push(ms);
    clock += ms;
    return Promise.resolve();
  });
  await pacer.wait("av", 2000);
  clock += 500;
  await pacer.wait("av", 2000); // 500 ms after the first: waits the other 1.5 s
  await pacer.wait("fh", 2000); // a different provider doesn't wait
  await Promise.all([pacer.wait("av", 2000), pacer.wait("av", 2000)]); // concurrent callers queue
  await pacer.wait("paid", 0);
  await pacer.wait("paid", 0);
  assert.deepEqual(slept, [1500, 2000, 2000]);
});

Deno.test("migration 0011 turns existing keys and consents into providers", () => {
  const db = openDatabase(":memory:");
  db.exec("PRAGMA foreign_keys = OFF");
  const dir = new URL("../server/db/migrations/data/", import.meta.url);
  const files = [...Deno.readDirSync(dir)].map((e) => e.name).filter((n) => n < "0011").sort();
  for (const f of files) db.exec(Deno.readTextFileSync(new URL(f, dir)));
  db.exec(`PRAGMA user_version = ${files.length}; PRAGMA foreign_keys = ON;`);
  db.exec(`
    INSERT INTO settings(key, value) VALUES ('api_key:alphavantage', 'AVKEY'), ('base_currency', 'CAD');
    INSERT INTO consents(id, purpose, description, granted_at) VALUES
      ('c1', 'market_data:alphavantage', 'x', 1), ('c2', 'market_data:bankofcanada', 'x', 1);
  `);
  migrate(db, "data");
  const rows = db.prepare(
    "SELECT id, type, plan, api_key, daily_limit, position FROM providers ORDER BY position",
  )
    .all().map((r) => [r.id, r.type, r.plan, r.api_key, r.daily_limit, r.position]);
  assert.deepEqual(rows, [
    ["alphavantage", "alphavantage", "free", "AVKEY", 25, 1],
    ["bankofcanada", "bankofcanada", "free", null, 200, 3],
  ]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM settings WHERE key LIKE 'api_key:%'").get()!.n, 0);
});
