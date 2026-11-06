/** Deleting accounts and assets, and cash accounts without assets. */
import assert from "node:assert/strict";
import { migrate, openDatabase, openInMemory } from "../server/db/db.ts";
import { createApp } from "../server/app.ts";
import { resetLoginBrake } from "../server/services/auth.ts";

// deno-lint-ignore no-explicit-any
type J = Record<string, any>;

async function setup() {
  resetLoginBrake();
  const dbs = openInMemory();
  const app = createApp({ dbs, kdfIterations: 1000 });
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

Deno.test("cash accounts record a balance and hold no assets", async () => {
  const { ok, call } = await setup();
  const cash = await ok("POST", "/api/accounts", { name: "Chequing", kind: "cash" });
  assert.equal((await call("POST", "/api/assets", { account_id: cash.id, name: "Something" })).status, 400);
  await ok("POST", `/api/accounts/${cash.id}/snapshots`, { amount: "8400" });
  const other = await ok("POST", "/api/accounts", { name: "Misc", kind: "managed" });
  await ok("POST", "/api/assets", { account_id: other.id, name: "Watch" });
  assert.equal((await call("PATCH", `/api/accounts/${other.id}`, { kind: "cash" })).status, 409);
});

Deno.test("an account with no assets deletes with its balance history", async () => {
  const { dbs, ok, call } = await setup();
  const house = await ok("POST", "/api/accounts", { name: "House", kind: "cash" });
  const visa = await ok("POST", "/api/accounts", {
    name: "Card",
    kind: "cash",
    linked_account_id: house.id,
  });
  await ok("POST", `/api/accounts/${house.id}/snapshots`, { amount: "100" });
  const deps = await ok("GET", `/api/accounts/${house.id}/dependents`);
  assert.deepEqual([deps.assets.length, deps.balance_entries, deps.linked_from[0].name], [0, 1, "Card"]);
  await ok("DELETE", `/api/accounts/${house.id}`);
  assert.equal((await call("GET", `/api/accounts/${house.id}`)).status, 404);
  assert.equal((await ok("GET", `/api/accounts/${visa.id}`)).linked_account_id, null);
  assert.equal((dbs.data.prepare("SELECT count(*) AS n FROM account_snapshots").get() as J).n, 0);
});

Deno.test("assets block account deletion until their trades and theses are removed", async () => {
  const { ok, call } = await setup();
  const acct = await ok("POST", "/api/accounts", { name: "TFSA", kind: "self_directed" });
  const inst = await ok("POST", "/api/instruments", { symbol: "SHOP", kind: "equity", currency: "CAD" });
  const asset = await ok("POST", "/api/assets", { account_id: acct.id, instrument_id: inst.id });
  const buy = await ok("POST", `/api/assets/${asset.id}/buys`, {
    trade_date: "2026-01-02",
    quantity: "5",
    price: "100",
  });
  const sell = await ok("POST", `/api/assets/${asset.id}/sells`, {
    trade_date: "2026-02-02",
    quantity: "2",
    price: "120",
    allocations: [{ buy_trade_id: buy.id, quantity: "2" }],
  });
  const t = await ok("POST", "/api/theses", { title: "Canadian tech", status: "active" });
  const link = await ok("POST", `/api/theses/${t.id}/links`, { asset_id: asset.id, buy_trade_id: buy.id });

  const blocked = await call("DELETE", `/api/accounts/${acct.id}`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.details.assets[0].trades, 2);
  assert.deepEqual(blocked.body.details.assets[0].theses, ["Canadian tech"]);

  const deps = await ok("GET", `/api/assets/${asset.id}/dependents`);
  assert.deepEqual(deps.trades.map((x: J) => x.side), ["sell", "buy"], "sales listed first");
  assert.equal(deps.theses[0].title, "Canadian tech");
  assert.equal((await call("DELETE", `/api/assets/${asset.id}`)).status, 409);

  // Unlink, delete the trades (sale first), then the asset, then the account.
  await ok("POST", `/api/links/${link.id}/unlink`, { reason: "Closing the account" });
  await ok("DELETE", `/api/trades/${sell.trade.id}`);
  await ok("DELETE", `/api/trades/${buy.id}`); // its past (unlinked) link goes with it
  await ok("DELETE", `/api/assets/${asset.id}`);
  await ok("DELETE", `/api/accounts/${acct.id}`);
  assert.equal((await ok("GET", "/api/accounts")).length, 0);
  // Thesis history still shows the link and unlink.
  const history = (await ok("GET", `/api/theses/${t.id}/history`)) as unknown as J[];
  assert.ok(history.some((h) => h.entity_type === "thesis_link" && h.action === "unlink"));
});

Deno.test("a house deletes with its value history", async () => {
  const { dbs, ok } = await setup();
  const re = await ok("POST", "/api/accounts", { name: "Home", kind: "real_estate" });
  const house = await ok("POST", "/api/assets", {
    account_id: re.id,
    category: "property",
    name: "1 Elm St",
    value: "500000",
  });
  await ok("DELETE", `/api/assets/${house.id}`);
  assert.equal((dbs.data.prepare("SELECT count(*) AS n FROM asset_values").get() as J).n, 0);
  await ok("DELETE", `/api/accounts/${re.id}`);
});

Deno.test("migration 0008: old account types become simple accounts; liabilities turn negative", () => {
  const db = openDatabase(":memory:");
  db.exec("PRAGMA foreign_keys = OFF");
  const dir = new URL("../server/db/migrations/data/", import.meta.url);
  const files = [...Deno.readDirSync(dir)].map((e) => e.name).filter((n) => n < "0008").sort();
  for (const f of files) db.exec(Deno.readTextFileSync(new URL(f, dir)));
  db.exec(`PRAGMA user_version = ${files.length}; PRAGMA foreign_keys = ON;`);
  db.exec(`
    INSERT INTO accounts(id, name, kind, currency, created_at, updated_at) VALUES
      ('a1','Visa','credit_card','CAD',1,1), ('a2','Car','other_asset','CAD',1,1), ('a3','LOC','line_of_credit','CAD',1,1);
    INSERT INTO account_snapshots VALUES
      ('s1','a1','2026-06-01','value','1830.45','manual','',1), ('s2','a2','2026-06-01','value','12000','manual','',2),
      ('s3','a3','2026-06-01','value','0','manual','',3);
  `);
  migrate(db, "data");
  const kinds = db.prepare("SELECT kind FROM accounts ORDER BY id").all().map((r) => r.kind);
  assert.deepEqual(kinds, ["cash", "cash", "cash"]);
  const amounts = db.prepare("SELECT amount FROM account_snapshots ORDER BY id").all().map((r) => r.amount);
  assert.deepEqual(amounts, ["-1830.45", "12000", "0"]);
});
