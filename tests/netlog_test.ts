/** Communication log: every outbound call is recorded, with secrets masked. */
import assert from "node:assert/strict";
import { openInMemory } from "../server/db/db.ts";
import { createApp } from "../server/app.ts";
import { resetLoginBrake } from "../server/services/auth.ts";
import { maskUrl } from "../server/services/netlog.ts";

// deno-lint-ignore no-explicit-any
type J = Record<string, any>;

Deno.test("communication log records each outbound call with masked secrets", async () => {
  resetLoginBrake();
  const seen: Headers[] = [];
  const fakeFetch = ((input: string | URL, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    const url = new URL(String(input));
    if (url.hostname === "www.alphavantage.co") {
      return Promise.resolve(
        Response.json({ "Time Series (Daily)": { "2026-11-05": { "4. close": "101.5" } } }),
      );
    }
    if (url.hostname === "www.bankofcanada.ca") return Promise.resolve(new Response("down", { status: 503 }));
    return Promise.reject(new Error("connection refused"));
  }) as typeof fetch;
  const dbs = openInMemory();
  const app = createApp({ dbs, fetchFn: fakeFetch, kdfIterations: 1000 });
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
    return text ? JSON.parse(text) : {};
  };
  token = (await call("POST", "/api/setup", {
    passphrase: "correct horse battery staple",
    base_currency: "CAD",
    time_zone: "UTC",
  }))
    .token;
  const acct = await call("POST", "/api/accounts", {
    name: "Margin",
    kind: "self_directed",
    currency: "USD",
  });
  const inst = await call("POST", "/api/instruments", { symbol: "IBM", kind: "equity", currency: "USD" });
  const asset = await call("POST", "/api/assets", { account_id: acct.id, instrument_id: inst.id });
  await call("POST", `/api/assets/${asset.id}/buys`, {
    trade_date: "2026-01-02",
    quantity: "1",
    price: "90",
  });
  await call("POST", "/api/providers/alphavantage", { api_key: "SECRETKEY123", consent: true });
  await call("POST", "/api/providers/bankofcanada", { consent: true });
  const ch = await call("POST", "/api/channels", {
    kind: "ntfy",
    config: { server: "https://ntfy.example.com", topic: "t1", token: "tk_abc" },
  });
  await call("PATCH", `/api/channels/${ch.id}`, { consent: true });
  await call("POST", "/api/jobs/run");
  await call("POST", `/api/channels/${ch.id}/test`);

  const log = (await call("GET", "/api/network-log")) as J[];
  // Price, Bank of Canada (fails), Alpha Vantage FX fallback, alert test.
  assert.equal(log.length, 4);
  assert.ok(log.some((r) => r.purpose === "Exchange rate · USD/CAD · Alpha Vantage"));
  const price = log.find((r) => r.purpose === "Price · IBM · Alpha Vantage")!;
  assert.equal(price.status, 200);
  assert.ok(price.url.includes("apikey=••••") && !price.url.includes("SECRETKEY123"), price.url);
  assert.match(price.response_body, /101\.5/);
  const fx = log.find((r) => r.purpose.includes("Bank of Canada"))!;
  assert.equal(fx.status, 503);
  assert.equal(fx.response_body, "down");
  const alert = log.find((r) => r.purpose.startsWith("Alert test"))!;
  assert.equal(alert.status, null);
  assert.equal(alert.error, "connection refused");
  assert.equal(alert.request_headers.authorization, "••••");
  assert.match(alert.request_body, /new item to review/); // minimal detail
  assert.ok(seen.every((h) => !h.has("x-pfat-purpose")), "purpose header is not sent");

  // Paging and clearing.
  assert.equal(((await call("GET", `/api/network-log?before=${log[3].started_at}`)) as J[]).length, 0);
  await call("DELETE", "/api/network-log");
  assert.equal(((await call("GET", "/api/network-log")) as J[]).length, 0);
});

Deno.test("maskUrl hides keys and tokens", () => {
  assert.equal(
    maskUrl("https://finnhub.io/api/v1/quote?symbol=AAPL&token=abc"),
    "https://finnhub.io/api/v1/quote?symbol=AAPL&token=••••",
  );
});
