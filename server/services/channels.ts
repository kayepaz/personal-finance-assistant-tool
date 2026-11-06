/**
 * Outbound notification channels: webhook and ntfy. Nothing is sent until the user consents to the channel.
 * "minimal" detail sends only that something needs attention; "full" sends the notification title and text,
 * which can include tickers, prices and thesis titles. Deliveries go through an outbox and are retried.
 */
import { type DB, type Row, transaction } from "../db/db.ts";
import { uuidv7 } from "../lib/ids.ts";
import { badRequest, notFound } from "../lib/http.ts";
import * as v from "../lib/validate.ts";
import { hasConsent, setConsent } from "./prices.ts";

type Obj = Record<string, unknown>;

export const MAX_ATTEMPTS = 5;

interface NtfyConfig {
  server: string;
  topic: string;
  token?: string;
  priority?: number;
}
interface WebhookConfig {
  url: string;
  secret?: string;
}

const purpose = (id: string) => `channel:${id}`;

function httpUrl(value: string, field: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw badRequest(`'${field}' must be a URL`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw badRequest(`'${field}' must be http(s)`);
  return u.toString().replace(/\/$/, "");
}

function validateConfig(kind: string, c: unknown): NtfyConfig | WebhookConfig {
  if (typeof c !== "object" || c === null || Array.isArray(c)) throw badRequest("'config' must be an object");
  const o = c as Obj;
  if (kind === "ntfy") {
    const topic = v.reqStr(o, "topic", { max: 64 });
    if (!/^[A-Za-z0-9_-]+$/.test(topic)) throw badRequest("ntfy topic may only use letters, digits, - and _");
    return {
      server: httpUrl(v.str(o, "server", { optional: true, max: 300 }) || "https://ntfy.sh", "server"),
      topic,
      token: v.str(o, "token", { optional: true, max: 300 }) || undefined,
      priority: v.int(o, "priority", { optional: true, min: 1, max: 5 }),
    };
  }
  return {
    url: httpUrl(v.reqStr(o, "url", { max: 500 }), "url"),
    secret: v.str(o, "secret", { optional: true, max: 300 }) || undefined,
  };
}

/** What the consent prompt says, built from the actual destination and detail level. */
export function consentText(kind: string, config: NtfyConfig | WebhookConfig, detail: string): string {
  const where = kind === "ntfy"
    ? `the ntfy server ${(config as NtfyConfig).server} (topic "${(config as NtfyConfig).topic}")`
    : `the webhook ${(config as WebhookConfig).url}`;
  const what = detail === "full"
    ? "each new to-do's title and text, which can include ticker symbols, prices, percentages and thesis titles"
    : `a short "you have a new item to review" message (no tickers, amounts or thesis names)`;
  const extra = kind === "ntfy" && (config as NtfyConfig).server === "https://ntfy.sh"
    ? " The public ntfy.sh server can be read by anyone who knows the topic name; use a hard-to-guess topic or your own server."
    : "";
  return `PFAT will send ${what} to ${where}.${extra}`;
}

function present(db: DB, r: Row): Row {
  const config = JSON.parse(r.config as string);
  const pending = db.prepare(
    "SELECT count(*) AS n FROM notification_deliveries WHERE channel_id = ? AND status = 'pending'",
  ).get(r.id as string) as Row;
  return {
    ...r,
    enabled: r.enabled === 1,
    // Secrets are write-only.
    config: {
      ...config,
      token: config.token ? "••••" : undefined,
      secret: config.secret ? "••••" : undefined,
    },
    consent_text: consentText(r.kind as string, config, r.detail as string),
    consented: hasConsent(db, purpose(r.id as string)),
    pending: Number(pending.n),
  };
}

export function listChannels(db: DB): Row[] {
  return db.prepare("SELECT * FROM notification_channels ORDER BY created_at").all().map((r) =>
    present(db, r)
  );
}

function raw(db: DB, id: string): Row {
  const r = db.prepare("SELECT * FROM notification_channels WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw notFound("Channel not found");
  return r;
}

export function createChannel(db: DB, body: Obj): Row {
  const kind = v.oneOf(body, "kind", ["webhook", "ntfy"] as const)!;
  const config = validateConfig(kind, body.config);
  const id = uuidv7();
  const now = Date.now();
  db.prepare(
    `INSERT INTO notification_channels(id, kind, name, config, detail, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    id,
    kind,
    v.str(body, "name", { optional: true, max: 100 }) || (kind === "ntfy" ? "Phone (ntfy)" : "Webhook"),
    JSON.stringify(config),
    v.oneOf(body, "detail", ["minimal", "full"] as const, { optional: true }) ?? "minimal",
    now,
    now,
  );
  return present(db, raw(db, id));
}

/**
 * Update name/detail/enabled/config or consent. Changing where or what is sent revokes consent, because the
 * user agreed to a specific destination and detail level.
 */
export function updateChannel(db: DB, id: string, body: Obj): Row {
  const c = raw(db, id);
  return transaction(db, () => {
    let revoke = false;
    if (v.has(body, "name")) {
      db.prepare("UPDATE notification_channels SET name = ? WHERE id = ?").run(
        v.reqStr(body, "name", { max: 100 }),
        id,
      );
    }
    if (v.has(body, "detail")) {
      const detail = v.oneOf(body, "detail", ["minimal", "full"] as const)!;
      if (detail !== c.detail) revoke = true;
      db.prepare("UPDATE notification_channels SET detail = ? WHERE id = ?").run(detail, id);
    }
    if (v.has(body, "config")) {
      const old = JSON.parse(c.config as string);
      const incoming = { ...(body.config as Obj) };
      // "••••" (or blank) means keep the stored secret.
      for (const k of ["token", "secret"]) if (!incoming[k] || incoming[k] === "••••") incoming[k] = old[k];
      const config = validateConfig(c.kind as string, incoming);
      if (consentText(c.kind as string, config, "x") !== consentText(c.kind as string, old, "x")) {
        revoke = true;
      }
      db.prepare("UPDATE notification_channels SET config = ? WHERE id = ?").run(JSON.stringify(config), id);
    }
    if (v.has(body, "enabled")) {
      db.prepare("UPDATE notification_channels SET enabled = ? WHERE id = ?").run(
        v.bool(body, "enabled") ? 1 : 0,
        id,
      );
    }
    if (revoke) setConsent(db, purpose(id), "", false);
    if (v.has(body, "consent")) {
      const fresh = raw(db, id);
      const text = consentText(
        fresh.kind as string,
        JSON.parse(fresh.config as string),
        fresh.detail as string,
      );
      setConsent(db, purpose(id), text, v.bool(body, "consent")!);
    }
    db.prepare("UPDATE notification_channels SET updated_at = ? WHERE id = ?").run(Date.now(), id);
    return present(db, raw(db, id));
  });
}

export function deleteChannel(db: DB, id: string): void {
  raw(db, id);
  transaction(db, () => {
    setConsent(db, purpose(id), "", false);
    db.prepare("DELETE FROM notification_channels WHERE id = ?").run(id);
  });
}

// ---------- delivery ----------

/** Queue a notification for every enabled, consented channel. Call when a notification is created. */
export function enqueue(db: DB, notificationId: string): void {
  for (const c of db.prepare("SELECT id FROM notification_channels WHERE enabled = 1").all()) {
    if (!hasConsent(db, purpose(c.id as string))) continue;
    db.prepare(
      `INSERT OR IGNORE INTO notification_deliveries(id, notification_id, channel_id, status, created_at)
       VALUES (?, ?, ?, 'pending', ?)`,
    ).run(uuidv7(), notificationId, c.id as string, Date.now());
  }
}

interface Message {
  title: string;
  body: string;
  kind: string;
  id: string;
  created_at: number;
}

async function hmacHex(secret: string, text: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function send(channel: Row, msg: Message, fetchFn: typeof fetch): Promise<void> {
  const config = JSON.parse(channel.config as string);
  const full = channel.detail === "full";
  const title = full ? msg.title : "PFAT";
  const text = full ? (msg.body || msg.title) : "You have a new item to review.";
  const signal = AbortSignal.timeout(15_000);
  let res: Response;
  if (channel.kind === "ntfy") {
    const c = config as NtfyConfig;
    const headers: Record<string, string> = { Title: encodeHeader(title), Tags: "chart_with_upwards_trend" };
    if (c.priority) headers.Priority = String(c.priority);
    if (c.token) headers.Authorization = `Bearer ${c.token}`;
    res = await fetchFn(`${c.server}/${c.topic}`, { method: "POST", headers, body: text, signal });
  } else {
    const c = config as WebhookConfig;
    const payload = JSON.stringify({
      app: "pfat",
      event: "notification.created",
      notification: full
        ? { id: msg.id, kind: msg.kind, title: msg.title, body: msg.body, created_at: msg.created_at }
        : { id: msg.id, kind: msg.kind, created_at: msg.created_at },
    });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (c.secret) headers["X-PFAT-Signature"] = `sha256=${await hmacHex(c.secret, payload)}`;
    res = await fetchFn(c.url, { method: "POST", headers, body: payload, signal });
  }
  await res.body?.cancel();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** HTTP header values must be ASCII; ntfy accepts RFC 2047 encoded-words for anything else. */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  return `=?UTF-8?B?${btoa(String.fromCharCode(...bytes))}?=`;
}

export interface DispatchResult {
  sent: number;
  failed: number;
}

/** Send pending deliveries; failures are retried on later runs up to MAX_ATTEMPTS. */
export async function dispatch(db: DB, fetchFn: typeof fetch = fetch): Promise<DispatchResult> {
  const pending = db.prepare(
    `SELECT d.id AS delivery_id, d.attempts, c.*, n.id AS n_id, n.kind AS n_kind, n.title AS n_title,
            n.body AS n_body, n.created_at AS n_created_at
     FROM notification_deliveries d
     JOIN notification_channels c ON c.id = d.channel_id
     JOIN notifications n ON n.id = d.notification_id
     WHERE d.status = 'pending' AND c.enabled = 1 ORDER BY d.created_at LIMIT 50`,
  ).all();
  const result: DispatchResult = { sent: 0, failed: 0 };
  for (const p of pending) {
    if (!hasConsent(db, purpose(p.id as string))) continue; // consent withdrawn: hold
    try {
      await send(p, {
        id: p.n_id as string,
        kind: p.n_kind as string,
        title: p.n_title as string,
        body: p.n_body as string,
        created_at: Number(p.n_created_at),
      }, fetchFn);
      db.prepare(
        "UPDATE notification_deliveries SET status = 'sent', attempts = attempts + 1, sent_at = ? WHERE id = ?",
      )
        .run(Date.now(), p.delivery_id as string);
      db.prepare("UPDATE notification_channels SET last_sent_at = ?, last_error = '' WHERE id = ?").run(
        Date.now(),
        p.id as string,
      );
      result.sent++;
    } catch (err) {
      const attempts = Number(p.attempts) + 1;
      const msg = (err as Error).message.slice(0, 300);
      db.prepare("UPDATE notification_deliveries SET attempts = ?, last_error = ?, status = ? WHERE id = ?")
        .run(attempts, msg, attempts >= MAX_ATTEMPTS ? "failed" : "pending", p.delivery_id as string);
      db.prepare("UPDATE notification_channels SET last_error = ? WHERE id = ?").run(msg, p.id as string);
      result.failed++;
    }
  }
  return result;
}

/** Send a test message right away (requires consent). */
export async function testChannel(db: DB, id: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const c = raw(db, id);
  if (!hasConsent(db, purpose(id))) throw badRequest("Agree to the consent text for this channel first");
  try {
    await send(c, {
      id: "test",
      kind: "test",
      title: "PFAT test notification",
      body: "If you can read this, PFAT can reach you here.",
      created_at: Date.now(),
    }, fetchFn);
    db.prepare("UPDATE notification_channels SET last_sent_at = ?, last_error = '' WHERE id = ?").run(
      Date.now(),
      id,
    );
  } catch (err) {
    db.prepare("UPDATE notification_channels SET last_error = ? WHERE id = ?").run(
      (err as Error).message,
      id,
    );
    throw badRequest(`Test failed: ${(err as Error).message}`);
  }
}
