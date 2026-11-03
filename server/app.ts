/** HTTP application: JSON API under /api, PWA client for everything else. */
import { stripTypeScriptTypes } from "node:module";
import { type Databases, getSetting } from "./db/db.ts";
import { type Ctx, errorResponse, HttpError, json, Router } from "./lib/http.ts";
import { today } from "./lib/dates.ts";
import * as v from "./lib/validate.ts";
import * as auth from "./services/auth.ts";
import * as accounts from "./services/accounts.ts";
import * as instruments from "./services/instruments.ts";
import * as assets from "./services/assets.ts";
import * as theses from "./services/theses.ts";
import * as notes from "./services/notifications.ts";
import * as prices from "./services/prices.ts";
import { type JobReport, runJobs } from "./services/engine.ts";

export interface AppOptions {
  dbs: Databases;
  clientDir?: URL;
  fetchFn?: typeof fetch;
  /** PBKDF2 iterations (tests use fewer). */
  kdfIterations?: number;
}

interface State {
  dbs: Databases;
  sessionId: string | null;
  today: () => string;
  fetchFn: typeof fetch;
}

type C = Ctx<State>;

const PUBLIC = new Set(["GET /api/status", "POST /api/setup", "POST /api/login"]);

function buildRouter(opts: AppOptions): Router<State> {
  const r = new Router<State>();
  const data = (c: C) => c.state.dbs.data;
  const cache = (c: C) => c.state.dbs.cache;
  let lastJobs: JobReport | null = null;

  // ----- setup & auth -----
  r.get("/api/status", (c) => ({ setup: auth.isSetUp(data(c)), authenticated: !!c.state.sessionId }));

  r.post("/api/setup", async (c) => {
    const b = await c.body();
    const passphrase = v.reqStr(b, "passphrase", { max: 1000 });
    await auth.setup(data(c), {
      passphrase,
      baseCurrency: v.currency(b, "base_currency")!,
      timeZone: v.reqStr(b, "time_zone", { max: 64 }),
    }, opts.kdfIterations);
    const s = await auth.login(data(c), passphrase, v.str(b, "device_name", { optional: true, max: 100 }) ?? "");
    return json({ token: s.token }, 201);
  });

  r.post("/api/login", async (c) => {
    const b = await c.body();
    const s = await auth.login(
      data(c),
      v.reqStr(b, "passphrase", { max: 1000 }),
      v.str(b, "device_name", { optional: true, max: 100 }) ?? "",
    );
    return { token: s.token };
  });

  r.post("/api/logout", (c) => auth.revokeSession(data(c), c.state.sessionId!));
  r.get("/api/sessions", (c) =>
    auth.listSessions(data(c)).map((s) => ({ ...s, current: s.id === c.state.sessionId })));
  r.delete("/api/sessions/:id", (c) => auth.revokeSession(data(c), c.params.id));

  // ----- settings & providers -----
  r.get("/api/settings", (c) => ({
    base_currency: getSetting(data(c), "base_currency"),
    time_zone: getSetting(data(c), "time_zone"),
    today: c.state.today(),
    providers: prices.providerStatus(data(c), cache(c), new Date().toISOString().slice(0, 10)),
    deferred: prices.listDeferred(cache(c)),
    last_jobs: lastJobs,
  }));

  r.post("/api/providers/:id", async (c) => {
    const b = await c.body();
    const p = prices.PROVIDERS.find((x) => x.id === c.params.id);
    if (!p) throw new HttpError(404, "Unknown provider");
    if (v.has(b, "api_key")) prices.setProviderKey(data(c), p.id, v.str(b, "api_key", { optional: true, max: 200 }) || null);
    if (v.has(b, "consent")) prices.setConsent(data(c), `market_data:${p.id}`, p.consentText, v.bool(b, "consent")!);
    return prices.providerStatus(data(c), cache(c), new Date().toISOString().slice(0, 10)).find((x) => x.id === p.id);
  });

  r.post("/api/jobs/run", async (c) => (lastJobs = await runJobs(c.state.dbs, c.state.fetchFn)));

  // ----- dashboard -----
  r.get("/api/dashboard", (c) => {
    const db = data(c);
    const count = (sql: string) => Number((db.prepare(sql).get() as Record<string, unknown>).n);
    return {
      todo: notes.countActionable(db, c.state.today()),
      theses_active: count("SELECT count(*) AS n FROM theses WHERE status IN ('active','triggered')"),
      theses_draft: count("SELECT count(*) AS n FROM theses WHERE status = 'draft'"),
      accounts: count("SELECT count(*) AS n FROM accounts WHERE archived_at IS NULL"),
      assets: count("SELECT count(*) AS n FROM assets WHERE archived_at IS NULL"),
    };
  });

  // ----- accounts -----
  r.get("/api/accounts", (c) => accounts.listAccounts(data(c), c.url.searchParams.get("archived") === "1"));
  r.post("/api/accounts", async (c) =>
    json(accounts.createAccount(data(c), await c.body(), getSetting(data(c), "base_currency") ?? "CAD"), 201));
  r.get("/api/accounts/:id", (c) => ({
    ...accounts.getAccount(data(c), c.params.id),
    assets: assets.listAssets(data(c), c.params.id),
    snapshots: accounts.listSnapshots(data(c), c.params.id),
  }));
  r.patch("/api/accounts/:id", async (c) => accounts.updateAccount(data(c), c.params.id, await c.body()));
  r.post("/api/accounts/:id/snapshots", async (c) => {
    const snap = accounts.addSnapshot(data(c), c.params.id, await c.body(), c.state.today());
    // Recording a balance completes any "update the balance" to-do for this account.
    data(c).prepare(
      `UPDATE notifications SET status = 'resolved', resolution = 'updated', resolved_at = ?
       WHERE kind = 'balance_update_due' AND ref_id = ? AND status <> 'resolved'`,
    ).run(Date.now(), c.params.id);
    return json(snap, 201);
  });

  // ----- instruments -----
  r.get("/api/instruments", (c) => instruments.listInstruments(data(c)));
  r.post("/api/instruments", async (c) => json(instruments.createInstrument(data(c), await c.body()), 201));

  // ----- assets & trades -----
  r.get("/api/assets", (c) => assets.listAssets(data(c), c.url.searchParams.get("account_id") ?? undefined));
  r.post("/api/assets", async (c) => json(assets.createAsset(data(c), await c.body()), 201));
  r.get("/api/assets/:id", (c) => {
    const a = assets.withPosition(data(c), assets.getAsset(data(c), c.params.id));
    return {
      ...a,
      trades: a.tracking === "trades" ? assets.listTrades(data(c), c.params.id) : [],
      links: theses.linksForAsset(data(c), c.params.id),
      latest_price: a.provider_symbol ? prices.latestPrice(cache(c), a.provider_symbol as string) ?? null : null,
    };
  });
  r.patch("/api/assets/:id", async (c) => assets.updateAsset(data(c), c.params.id, await c.body()));
  r.post("/api/assets/:id/buys", async (c) => json(assets.recordBuy(data(c), c.params.id, await c.body()), 201));
  r.post("/api/assets/:id/sells", async (c) => json(assets.recordSell(data(c), c.params.id, await c.body()), 201));
  r.get("/api/assets/:id/open-buys", (c) => assets.openBuys(data(c), c.params.id));
  r.delete("/api/trades/:id", (c) => assets.deleteTrade(data(c), c.params.id));

  // ----- theses -----
  r.get("/api/theses", (c) => theses.listTheses(data(c), c.url.searchParams.get("status") ?? undefined));
  r.post("/api/theses", async (c) => json(theses.createThesis(data(c), await c.body()), 201));
  r.get("/api/theses/:id", (c) => theses.getThesis(data(c), c.params.id));
  r.patch("/api/theses/:id", async (c) => theses.updateThesis(data(c), c.params.id, await c.body()));
  r.get("/api/theses/:id/history", (c) => theses.thesisHistory(data(c), c.params.id));
  r.post("/api/theses/:id/links", async (c) => json(theses.createLink(data(c), c.params.id, await c.body()), 201));
  r.post("/api/links/:id/unlink", async (c) => theses.unlink(data(c), c.params.id, await c.body()));
  r.post("/api/theses/:id/claims", async (c) =>
    json(theses.createClaim(data(c), c.params.id, await c.body(), c.state.today()), 201));
  r.patch("/api/claims/:id", async (c) => theses.updateClaim(data(c), c.params.id, await c.body(), c.state.today()));
  r.get("/api/claims/:id/reviews", (c) => theses.listClaimReviews(data(c), c.params.id));
  r.post("/api/claims/:id/reviews", async (c) =>
    json(theses.reviewClaim(data(c), c.params.id, await c.body(), c.state.today()), 201));
  r.post("/api/theses/:id/reasoning", async (c) => json(theses.addReasoning(data(c), c.params.id, await c.body()), 201));
  r.post("/api/theses/:id/triggers", async (c) => json(theses.createTrigger(data(c), c.params.id, await c.body()), 201));
  r.patch("/api/triggers/:id", async (c) => theses.updateTrigger(data(c), c.params.id, await c.body()));

  // ----- notifications -----
  r.get("/api/notifications", (c) =>
    c.url.searchParams.get("all") === "1"
      ? notes.listAll(data(c), c.url.searchParams.get("status") ?? undefined)
      : notes.listActionable(data(c), c.state.today()));
  r.post("/api/notifications/:id/actions", async (c) =>
    notes.actOn(data(c), c.params.id, await c.body(), c.state.today()));

  return r;
}

// ----- static client -----

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const transpiled = new Map<string, { mtime: number; code: string }>();

async function serveStatic(clientDir: URL, pathname: string): Promise<Response> {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (rel === "" || !/\.[a-z]+$/.test(rel)) rel = "index.html"; // SPA fallback
  if (rel.split("/").some((p) => p === ".." || p.startsWith("."))) return new Response("Not found", { status: 404 });
  const fileUrl = new URL(rel, clientDir);
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(fileUrl);
    if (!stat.isFile) throw new Error();
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const ext = rel.slice(rel.lastIndexOf("."));
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
    "cache-control": "no-cache",
  };
  if (rel === "sw.js") headers["service-worker-allowed"] = "/";
  if (ext === ".ts") {
    const mtime = stat.mtime?.getTime() ?? 0;
    let entry = transpiled.get(rel);
    if (!entry || entry.mtime !== mtime) {
      const source = await Deno.readTextFile(fileUrl);
      // Client code uses erasable TypeScript only, so stripping types is enough.
      const code = stripTypeScriptTypes(source);
      entry = { mtime, code };
      transpiled.set(rel, entry);
    }
    return new Response(entry.code, { headers });
  }
  return new Response(await Deno.readFile(fileUrl), { headers });
}

export function createApp(opts: AppOptions): (req: Request) => Promise<Response> {
  const router = buildRouter(opts);
  const clientDir = opts.clientDir ?? new URL("../client/", import.meta.url);
  const todayFn = () => today(getSetting(opts.dbs.data, "time_zone"));

  return async (req) => {
    const url = new URL(req.url);
    try {
      if (!url.pathname.startsWith("/api/")) {
        if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
        return await serveStatic(clientDir, url.pathname);
      }
      const header = req.headers.get("authorization");
      const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
      const sessionId = await auth.authenticate(opts.dbs.data, token);
      const found = router.match(req.method, url.pathname);
      if (!found) throw new HttpError(404, "No such endpoint");
      const key = `${req.method} ${url.pathname.replace(/\/$/, "")}`;
      if (!sessionId && !PUBLIC.has(key)) throw new HttpError(401, "Sign in required");
      const res = await router.handle(req, url, {
        dbs: opts.dbs,
        sessionId,
        today: todayFn,
        fetchFn: opts.fetchFn ?? fetch,
      });
      return res ?? json({ error: "No such endpoint" }, 404);
    } catch (err) {
      return errorResponse(err);
    }
  };
}
