/** Real estate accounts: houses (declared value) and mortgages (owed), valued as their sum. */
import assert from "node:assert/strict";
import { migrate, openDatabase, openInMemory } from "../server/db/db.ts";
import { createApp } from "../server/app.ts";
import { queueBalanceUpdates } from "../server/services/engine.ts";
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

Deno.test("real estate: houses and mortgages only, valued as their sum, no cash", async () => {
  const { dbs, ok, call } = await setup();
  const re = await ok("POST", "/api/accounts", { name: "Home", kind: "real_estate", update_every_days: 90 });

  // Only houses and mortgages, each with a starting value.
  assert.equal((await call("POST", "/api/assets", { account_id: re.id, name: "X" })).status, 400);
  assert.equal(
    (await call("POST", "/api/assets", { account_id: re.id, category: "property", name: "12 Main St" }))
      .status,
    400,
  );
  const inst = await ok("POST", "/api/instruments", { symbol: "VFV", kind: "etf", currency: "CAD" });
  assert.equal(
    (await call("POST", "/api/assets", {
      account_id: re.id,
      instrument_id: inst.id,
      category: "property",
      name: "x",
      value: "1",
    })).status,
    400,
  );
  const house = await ok("POST", "/api/assets", {
    account_id: re.id,
    category: "property",
    name: "12 Main St",
    value: "950000",
    as_of: "2026-06-01",
    value_note: "BC Assessment",
  });
  const mortgage = await ok("POST", "/api/assets", {
    account_id: re.id,
    category: "mortgage",
    name: "TD mortgage",
    value: "512000",
    as_of: "2026-06-01",
  });
  assert.equal(house.value, "950000");

  // No account-level balance or cash.
  assert.equal((await call("POST", `/api/accounts/${re.id}/snapshots`, { amount: "1" })).status, 400);

  let sheet = (await ok("GET", "/api/reports")).balance_sheet;
  const acct = sheet.accounts.find((a: J) => a.id === re.id);
  assert.equal(acct.value_base, "438000");
  assert.deepEqual(acct.items.map((i: J) => [i.name, i.value_native]), [["12 Main St", "950000"], [
    "TD mortgage",
    "-512000",
  ]]);
  assert.equal(sheet.totals.net_worth, "438000");

  // New values replace old ones; history is kept; the last value can't be deleted.
  await ok("POST", `/api/assets/${mortgage.id}/values`, { amount: "508500", as_of: "2026-11-01" });
  const m = await ok("GET", `/api/assets/${mortgage.id}`);
  assert.equal(m.value, "508500");
  assert.equal(m.values.length, 2);
  assert.equal(
    (await call("DELETE", `/api/asset-values/${(await ok("GET", `/api/assets/${house.id}`)).values[0].id}`))
      .status,
    409,
  );
  sheet = (await ok("GET", "/api/reports")).balance_sheet;
  assert.equal(sheet.accounts.find((a: J) => a.id === re.id).value_base, "441500");

  // A house can be in a thesis (its declared value counts); a mortgage can't.
  const t = await ok("POST", "/api/theses", { title: "Vancouver real estate", status: "active" });
  await ok("POST", `/api/theses/${t.id}/links`, { asset_id: house.id });
  assert.equal((await call("POST", `/api/theses/${t.id}/links`, { asset_id: mortgage.id })).status, 400);
  const byThesis = (await ok("GET", "/api/reports")).by_thesis;
  assert.equal(byThesis.slices.find((x: J) => x.label === "Vancouver real estate").value, "950000");

  // Reminder follows the least recently updated item (the house, from June).
  assert.equal(queueBalanceUpdates(dbs.data, "2026-09-15"), 1);
  const [n] = (await ok("GET", "/api/notifications")) as unknown as J[];
  assert.match(n.title, /house values and mortgage balances/);

  // Type changes: can't leave real estate while it holds houses/mortgages.
  assert.equal((await call("PATCH", `/api/accounts/${re.id}`, { kind: "managed" })).status, 409);
});

Deno.test("real estate: switching an account to real estate moves its balances onto a house", async () => {
  const { ok } = await setup();
  const a = await ok("POST", "/api/accounts", { name: "Cabin", kind: "other_asset" });
  await ok("POST", `/api/accounts/${a.id}/snapshots`, { amount: "300000", as_of: "2026-01-01" });
  await ok("PATCH", `/api/accounts/${a.id}`, { kind: "real_estate" });
  const acct = await ok("GET", `/api/accounts/${a.id}`);
  assert.equal(acct.snapshots.length, 0);
  assert.equal(acct.assets.length, 1);
  assert.deepEqual([acct.assets[0].name, acct.assets[0].category, acct.assets[0].value], [
    "Cabin",
    "property",
    "300000",
  ]);
});

Deno.test("migration 0007: existing real estate balances become a house", () => {
  const db = openDatabase(":memory:");
  db.exec("PRAGMA foreign_keys = OFF");
  for (const f of [1, 2, 3, 4, 5, 6]) {
    const name = [...Deno.readDirSync(new URL("../server/db/migrations/data/", import.meta.url))]
      .map((e) => e.name).find((n) => n.startsWith(String(f).padStart(4, "0")))!;
    db.exec(Deno.readTextFileSync(new URL(`../server/db/migrations/data/${name}`, import.meta.url)));
  }
  db.exec("PRAGMA user_version = 6; PRAGMA foreign_keys = ON;");
  db.exec(`
    INSERT INTO accounts(id, name, kind, currency, created_at, updated_at) VALUES
      ('a1','Main St house','real_estate','CAD',1,1), ('a2','Visa','credit_card','CAD',1,1);
    INSERT INTO account_snapshots VALUES
      ('s1','a1','2026-01-01','value','900000','manual','',1), ('s2','a1','2026-06-01','value','950000','manual','',2),
      ('s3','a2','2026-06-01','value','1200','manual','',3);
  `);
  migrate(db, "data");
  const assets = db.prepare("SELECT id, name, category FROM assets").all();
  assert.deepEqual(assets.map((x) => [x.name, x.category]), [["Main St house", "property"]]);
  const values = db.prepare("SELECT amount FROM asset_values ORDER BY as_of").all().map((r) => r.amount);
  assert.deepEqual(values, ["900000", "950000"]);
  const left = db.prepare("SELECT account_id FROM account_snapshots").all().map((r) => r.account_id);
  assert.deepEqual(left, ["a2"]);
});
