/** v0.3: encrypted backups, notification channels, trailing stops. */
import assert from "node:assert/strict";
import { openAll, openInMemory } from "../server/db/db.ts";
import { createApp } from "../server/app.ts";
import { createBackup, decryptBackup, readHeader, restoreBackup } from "../server/services/backup.ts";
import { createNotification } from "../server/services/notifications.ts";
import { dispatch } from "../server/services/channels.ts";
import { evaluateTriggers } from "../server/services/engine.ts";
import { storePrice } from "../server/services/prices.ts";
import { resetLoginBrake } from "../server/services/auth.ts";

// deno-lint-ignore no-explicit-any
type J = Record<string, any>;

function client(app: (r: Request) => Promise<Response>) {
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
    const type = res.headers.get("content-type") ?? "";
    const payload = type.includes("json") ? await res.json() : new Uint8Array(await res.arrayBuffer());
    return { status: res.status, body: payload as J, headers: res.headers };
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await call(method, path, body);
    assert.ok(r.status < 300, `${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  return { call, ok, setToken: (t: string) => (token = t) };
}

async function signedIn(app: (r: Request) => Promise<Response>, passphrase = "correct horse battery staple") {
  resetLoginBrake();
  const c = client(app);
  const s = await c.call("POST", "/api/setup", { passphrase, base_currency: "CAD", time_zone: "UTC" });
  assert.equal(s.status, 201);
  c.setToken(s.body.token);
  return c;
}

const PASS = "a long backup passphrase";

Deno.test("backup: encrypted, authenticated, and restores data over the live database", async () => {
  const dir = Deno.makeTempDirSync();
  try {
    const dbs = openAll(dir);
    const app = createApp({ dbs, kdfIterations: 1000 });
    const c = await signedIn(app);
    await c.ok("POST", "/api/theses", { title: "Before backup", status: "active" });

    assert.equal(
      (await c.call("POST", "/api/backups", { contents: "both", passphrase: "short" })).status,
      400,
    );
    const res = await c.call("POST", "/api/backups", { contents: "both", passphrase: PASS });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition")!, /pfat-both-\d+\.pfatbak/);
    const file = res.body as unknown as Uint8Array;

    // The header is readable; the data is not.
    const { header } = readHeader(file);
    assert.deepEqual(header.contents, ["data", "cache"]);
    assert.ok(!new TextDecoder().decode(file).includes("Before backup"));

    // Wrong passphrase and tampering are both rejected.
    await assert.rejects(decryptBackup(file, "the wrong passphrase!"), /Wrong passphrase/);
    const tampered = file.slice();
    const at = new TextDecoder().decode(tampered.subarray(0, 300)).indexOf("created_at") + 14;
    tampered[at] = tampered[at] === 0x31 ? 0x32 : 0x31; // alter one digit of the header's date
    await assert.rejects(decryptBackup(tampered, PASS));

    // Restoring a data-only backup keeps a safety copy of what it replaces.
    await c.ok("POST", "/api/theses", { title: "After backup", status: "active" });
    const dataOnly = await createBackup(dbs, "data", PASS, 1000);
    const r = await restoreBackup(dbs, dataOnly.bytes, PASS);
    assert.deepEqual(r.restored, ["data"]);
    assert.ok(Deno.statSync(`${r.safety_copy}/data.db`).isFile);

    // Restore the earlier full backup through the API.
    const res2 = await app(
      new Request("http://pfat.test/api/restore", {
        method: "POST",
        headers: {
          authorization: `Bearer ${(await loginToken(app))}`,
          "x-pfat-backup-passphrase": btoa(PASS),
        },
        body: file as BodyInit,
      }),
    );
    assert.equal(res2.status, 200, await res2.clone().text());
    const titles = dbs.data.prepare("SELECT title FROM theses ORDER BY title").all().map((t) => t.title);
    assert.deepEqual(titles, ["Before backup"]);
    dbs.data.close();
    dbs.cache.close();
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

async function loginToken(app: (r: Request) => Promise<Response>): Promise<string> {
  resetLoginBrake();
  const res = await app(
    new Request("http://pfat.test/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "correct horse battery staple" }),
    }),
  );
  return (await res.json()).token;
}

Deno.test("channels: nothing is sent without consent; minimal hides details; failures retry", async () => {
  const dbs = openInMemory();
  const sent: { url: string; headers: Headers; body: string }[] = [];
  let fail = 0;
  const fakeFetch = ((input: string | URL, init?: RequestInit) => {
    sent.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body ?? "") });
    if (fail > 0) {
      fail--;
      return Promise.resolve(new Response("nope", { status: 502 }));
    }
    return Promise.resolve(new Response("ok"));
  }) as typeof fetch;
  const app = createApp({ dbs, fetchFn: fakeFetch, kdfIterations: 1000 });
  const c = await signedIn(app);

  const ntfy = await c.ok("POST", "/api/channels", {
    kind: "ntfy",
    config: { server: "https://ntfy.example.com", topic: "pfat-kaye-7f3a", token: "tk_secret" },
  });
  assert.equal(ntfy.detail, "minimal");
  assert.equal(ntfy.config.token, "••••");
  assert.match(ntfy.consent_text, /\(no tickers, amounts or thesis names\)/);
  assert.equal((await c.call("POST", `/api/channels/${ntfy.id}/test`)).status, 400, "test needs consent");

  createNotification(dbs.data, {
    kind: "trigger_fired",
    title: "NVDA has fallen 12%",
    body: "Price 88",
    refType: "trigger",
    refId: "x",
  });
  assert.deepEqual(await dispatch(dbs.data, fakeFetch), { sent: 0, failed: 0 });

  await c.ok("PATCH", `/api/channels/${ntfy.id}`, { consent: true });
  createNotification(dbs.data, {
    kind: "trigger_fired",
    title: "NVDA has fallen 12%",
    body: "Price 88",
    refType: "trigger",
    refId: "y",
  });
  assert.deepEqual(await dispatch(dbs.data, fakeFetch), { sent: 1, failed: 0 });
  assert.equal(sent[0].url, "https://ntfy.example.com/pfat-kaye-7f3a");
  assert.equal(sent[0].headers.get("authorization"), "Bearer tk_secret");
  assert.ok(
    !sent[0].body.includes("NVDA") && !sent[0].headers.get("title")!.includes("NVDA"),
    "minimal hides details",
  );

  // Switching to full detail withdraws consent until the user agrees to the new text.
  const full = await c.ok("PATCH", `/api/channels/${ntfy.id}`, { detail: "full" });
  assert.equal(full.consented, false);
  assert.match(full.consent_text, /ticker symbols, prices/);

  // Webhook: signed JSON, retried after a failure.
  const hook = await c.ok("POST", "/api/channels", {
    kind: "webhook",
    detail: "full",
    config: { url: "https://hooks.example.com/pfat", secret: "s3cret" },
  });
  await c.ok("PATCH", `/api/channels/${hook.id}`, { consent: true });
  fail = 1;
  createNotification(dbs.data, {
    kind: "claim_review_due",
    title: "Review claim",
    body: "Still true?",
    refType: "claim",
    refId: "z",
  });
  assert.deepEqual(await dispatch(dbs.data, fakeFetch), { sent: 0, failed: 1 });
  assert.deepEqual(await dispatch(dbs.data, fakeFetch), { sent: 1, failed: 0 });
  const last = sent.at(-1)!;
  assert.equal(JSON.parse(last.body).notification.title, "Review claim");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("s3cret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = Array.from(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(last.body))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  assert.equal(last.headers.get("x-pfat-signature"), `sha256=${expected}`);

  // Test button works once consented.
  assert.equal((await c.call("POST", `/api/channels/${hook.id}/test`)).status, 200);
});

Deno.test("trailing stop: tracks the highest close and fires on a drop from it", async () => {
  const dbs = openInMemory();
  const app = createApp({ dbs, kdfIterations: 1000 });
  const c = await signedIn(app);
  const acct = await c.ok("POST", "/api/accounts", {
    name: "Margin",
    kind: "self_directed",
    currency: "USD",
  });
  const inst = await c.ok("POST", "/api/instruments", { symbol: "TSLA", kind: "equity", currency: "USD" });
  const asset = await c.ok("POST", "/api/assets", { account_id: acct.id, instrument_id: inst.id });
  const buy = await c.ok("POST", `/api/assets/${asset.id}/buys`, {
    trade_date: "2026-10-01",
    quantity: "5",
    price: "200",
  });
  const t = await c.ok("POST", "/api/theses", { title: "Momentum", status: "active" });
  await c.ok("POST", `/api/theses/${t.id}/links`, { asset_id: asset.id, buy_trade_id: buy.id });
  assert.equal(
    (await c.call("POST", "/api/triggers", { type: "trailing_stop", params: { percent: "100" } })).status,
    400,
  );
  await c.ok("POST", "/api/triggers", {
    thesis_id: t.id,
    type: "trailing_stop",
    label: "15% trail",
    params: { percent: "15" },
  });

  storePrice(dbs.cache, "TSLA", { date: "2026-10-10", close: "260" }, "USD", "t");
  storePrice(dbs.cache, "TSLA", { date: "2026-10-20", close: "240" }, "USD", "t");
  assert.equal(evaluateTriggers(dbs.data, dbs.cache, "2026-10-20"), 0, "240 is above the 221 stop");
  storePrice(dbs.cache, "TSLA", { date: "2026-10-21", close: "300" }, "USD", "t");
  assert.equal(evaluateTriggers(dbs.data, dbs.cache, "2026-10-21"), 0, "new high");
  storePrice(dbs.cache, "TSLA", { date: "2026-10-22", close: "250" }, "USD", "t");
  assert.equal(evaluateTriggers(dbs.data, dbs.cache, "2026-10-22"), 1, "250 is below 255 (15% under 300)");
  const [n] = (await c.ok("GET", "/api/notifications")) as unknown as J[];
  assert.equal(n.firing.observed.high, "300");
  assert.equal(n.firing.observed.stop, "255");

  // The high-water mark survives clearing the cache.
  dbs.cache.exec("DELETE FROM daily_prices");
  const row = dbs.data.prepare("SELECT high FROM trailing_highs").get() as J;
  assert.equal(row.high, "300");
});
