/** Passphrase setup/login and per-device sessions. */
import { type DB, getSetting, type Row, setSetting, transaction } from "../db/db.ts";
import { uuidv7 } from "../lib/ids.ts";
import { badRequest, conflict, HttpError } from "../lib/http.ts";

const PBKDF2_ITERATIONS = 600_000;
const MIN_PASSPHRASE = 12;
const enc = new TextEncoder();

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function pbkdf2(passphrase: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return b64(new Uint8Array(digest));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function isSetUp(db: DB): boolean {
  return getSetting(db, "passphrase_hash") !== undefined;
}

export interface SetupInput {
  passphrase: string;
  baseCurrency: string;
  timeZone: string;
}

export async function setup(db: DB, input: SetupInput, iterations = PBKDF2_ITERATIONS): Promise<void> {
  if (isSetUp(db)) throw conflict("PFAT is already set up");
  if (input.passphrase.length < MIN_PASSPHRASE) {
    throw badRequest(`Passphrase must be at least ${MIN_PASSPHRASE} characters`);
  }
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: input.timeZone });
  } catch {
    throw badRequest("Unknown time zone");
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(input.passphrase, salt, iterations);
  transaction(db, () => {
    setSetting(db, "passphrase_hash", JSON.stringify({ v: 1, iterations, salt: b64(salt), hash: b64(hash) }));
    setSetting(db, "base_currency", input.baseCurrency);
    setSetting(db, "time_zone", input.timeZone);
    setSetting(db, "installed_at", String(Date.now()));
  });
}

// Simple in-memory brake on repeated wrong passphrases.
let failures = 0;
let lockedUntil = 0;

export async function verifyPassphrase(db: DB, passphrase: string): Promise<boolean> {
  const stored = getSetting(db, "passphrase_hash");
  if (!stored) return false;
  const { iterations, salt, hash } = JSON.parse(stored);
  const candidate = await pbkdf2(passphrase, unb64(salt), iterations);
  return timingSafeEqual(candidate, unb64(hash));
}

export async function login(
  db: DB,
  passphrase: string,
  deviceName: string,
): Promise<{ token: string; sessionId: string }> {
  if (!isSetUp(db)) throw new HttpError(409, "PFAT is not set up yet");
  if (Date.now() < lockedUntil) throw new HttpError(429, "Too many attempts; try again shortly");
  if (!(await verifyPassphrase(db, passphrase))) {
    failures++;
    if (failures >= 5) lockedUntil = Date.now() + Math.min(60_000 * 2 ** (failures - 5), 15 * 60_000);
    throw new HttpError(401, "Wrong passphrase");
  }
  failures = 0;
  const token = b64(crypto.getRandomValues(new Uint8Array(32)));
  const id = uuidv7();
  const now = Date.now();
  db.prepare(
    "INSERT INTO sessions(id, token_hash, device_name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, await sha256(token), deviceName.slice(0, 100) || "Unnamed device", now, now);
  return { token, sessionId: id };
}

export async function authenticate(db: DB, token: string | null): Promise<string | null> {
  if (!token) return null;
  const row = db.prepare("SELECT id, last_seen_at FROM sessions WHERE token_hash = ? AND revoked_at IS NULL")
    .get(await sha256(token)) as Row | undefined;
  if (!row) return null;
  const now = Date.now();
  if (now - Number(row.last_seen_at) > 60_000) {
    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(now, row.id as string);
  }
  return row.id as string;
}

export function listSessions(db: DB): Row[] {
  return db.prepare(
    "SELECT id, device_name, created_at, last_seen_at FROM sessions WHERE revoked_at IS NULL ORDER BY last_seen_at DESC",
  ).all();
}

export function revokeSession(db: DB, id: string): void {
  db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(Date.now(), id);
}

/** Test hook. */
export function resetLoginBrake(): void {
  failures = 0;
  lockedUntil = 0;
}
