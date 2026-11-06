/**
 * Encrypted backups. A backup is one file:
 *
 *   "PFATBAK1\n" + header JSON + "\n" + AES-256-GCM ciphertext
 *
 * The header (format, contents, schema versions, KDF salt, IV) is readable without the passphrase and is
 * authenticated as AES-GCM additional data, so it can't be altered. The ciphertext is a gzip-compressed JSON
 * payload holding each selected SQLite database (a consistent copy made with SQLite's online backup). The key is derived
 * from a passphrase the user types, with PBKDF2-SHA256. A passphrase is always required.
 */
import { backup as sqliteBackup } from "node:sqlite";
import { type Databases, type DB, migrate, openDatabase, type Row } from "../db/db.ts";
import { badRequest, HttpError } from "../lib/http.ts";

const MAGIC = "PFATBAK1\n";
const ITERATIONS = 600_000;
const MIN_PASSPHRASE = 12;
const enc = new TextEncoder();
const dec = new TextDecoder();

export type Contents = "data" | "cache" | "both";

interface Header {
  format: "pfat-backup";
  version: 1;
  created_at: string;
  contents: ("data" | "cache")[];
  schema: Record<string, number>;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  cipher: { name: "AES-GCM"; iv: string };
}

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function gzip(bytes: Uint8Array, mode: "compress" | "decompress"): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(
    mode === "compress" ? new CompressionStream("gzip") : new DecompressionStream("gzip"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A consistent byte copy of a database (works for in-memory databases too). */
async function snapshotBytes(db: DB): Promise<Uint8Array> {
  const dir = Deno.makeTempDirSync();
  try {
    await sqliteBackup(db, `${dir}/copy.db`);
    return Deno.readFileSync(`${dir}/copy.db`);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

function userVersion(db: DB): number {
  return Number((db.prepare("PRAGMA user_version").get() as Row).user_version);
}

export function checkPassphrase(passphrase: unknown): string {
  if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE) {
    throw badRequest(`Backup passphrase must be at least ${MIN_PASSPHRASE} characters`);
  }
  return passphrase;
}

export async function createBackup(
  dbs: Databases,
  contents: Contents,
  passphrase: string,
  iterations = ITERATIONS,
): Promise<{ bytes: Uint8Array; filename: string }> {
  checkPassphrase(passphrase);
  const parts: ("data" | "cache")[] = contents === "both" ? ["data", "cache"] : [contents];
  const payload: Record<string, string> = {};
  const schema: Record<string, number> = {};
  for (const p of parts) {
    payload[p] = b64(await snapshotBytes(dbs[p]));
    schema[p] = userVersion(dbs[p]);
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const now = new Date();
  const header: Header = {
    format: "pfat-backup",
    version: 1,
    created_at: now.toISOString(),
    contents: parts,
    schema,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: b64(salt) },
    cipher: { name: "AES-GCM", iv: b64(iv) },
  };
  const headerBytes = enc.encode(JSON.stringify(header));
  const key = await deriveKey(passphrase, salt, iterations);
  const plain = await gzip(enc.encode(JSON.stringify(payload)), "compress");
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: headerBytes as BufferSource },
      key,
      plain as BufferSource,
    ),
  );
  const out = new Uint8Array(MAGIC.length + headerBytes.length + 1 + cipher.length);
  out.set(enc.encode(MAGIC), 0);
  out.set(headerBytes, MAGIC.length);
  out[MAGIC.length + headerBytes.length] = 0x0a;
  out.set(cipher, MAGIC.length + headerBytes.length + 1);
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, "");
  return { bytes: out, filename: `pfat-${contents}-${stamp}.pfatbak` };
}

export function readHeader(
  bytes: Uint8Array,
): { header: Header; headerBytes: Uint8Array; cipher: Uint8Array } {
  if (dec.decode(bytes.subarray(0, MAGIC.length)) !== MAGIC) {
    throw badRequest("This is not a PFAT backup file");
  }
  const end = bytes.indexOf(0x0a, MAGIC.length);
  if (end < 0) throw badRequest("Backup file is damaged");
  const headerBytes = bytes.subarray(MAGIC.length, end);
  let header: Header;
  try {
    header = JSON.parse(dec.decode(headerBytes));
  } catch {
    throw badRequest("Backup file is damaged");
  }
  if (header.format !== "pfat-backup" || header.version !== 1) throw badRequest("Unsupported backup version");
  const it = header.kdf?.iterations;
  if (!Number.isInteger(it) || it < 1000 || it > 5_000_000) throw badRequest("Backup file is damaged");
  return { header, headerBytes, cipher: bytes.subarray(end + 1) };
}

export async function decryptBackup(
  bytes: Uint8Array,
  passphrase: string,
): Promise<{ header: Header; files: Record<string, Uint8Array> }> {
  const { header, headerBytes, cipher } = readHeader(bytes);
  const key = await deriveKey(passphrase, unb64(header.kdf.salt), header.kdf.iterations);
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: unb64(header.cipher.iv) as BufferSource,
          additionalData: headerBytes as BufferSource,
        },
        key,
        cipher as BufferSource,
      ),
    );
  } catch {
    throw new HttpError(400, "Wrong passphrase, or the backup file has been altered");
  }
  const payload = JSON.parse(dec.decode(await gzip(plain, "decompress"))) as Record<string, string>;
  const files: Record<string, Uint8Array> = {};
  for (const p of header.contents) files[p] = unb64(payload[p]);
  return { header, files };
}

/** Write bytes to a temp file and check it is a healthy SQLite database at or below our schema version. */
function verifyDatabase(bytes: Uint8Array, set: "data" | "cache", maxVersion: number): string {
  const tmp = Deno.makeTempFileSync({ suffix: `.${set}.db` });
  Deno.writeFileSync(tmp, bytes);
  const db = openDatabase(tmp);
  try {
    const ok = (db.prepare("PRAGMA integrity_check").get() as Row).integrity_check;
    if (ok !== "ok") throw badRequest(`The ${set} database in this backup is damaged`);
    if (userVersion(db) > maxVersion) {
      throw badRequest(`This backup is from a newer version of PFAT; update PFAT before restoring it`);
    }
    migrate(db, set); // bring older backups up to the current schema
    db.exec("PRAGMA journal_mode = DELETE"); // fold the WAL back in so the single file is complete
  } finally {
    db.close();
  }
  return tmp;
}

export interface RestoreResult {
  restored: ("data" | "cache")[];
  safety_copy: string;
  backup_created_at: string;
}

/**
 * Replace the live databases with the backup's. The current files are first copied to
 * `<data dir>/pre-restore-<timestamp>/` so a restore can be undone by hand.
 */
export async function restoreBackup(
  dbs: Databases,
  bytes: Uint8Array,
  passphrase: string,
): Promise<RestoreResult> {
  if (!dbs.dir) throw badRequest("Restore needs on-disk databases");
  const { header, files } = await decryptBackup(bytes, passphrase);
  const verified: Record<string, string> = {};
  for (const set of header.contents) {
    verified[set] = verifyDatabase(files[set], set, userVersion(dbs[set]));
  }

  const stamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
  const safety = `${dbs.dir}/pre-restore-${stamp}`;
  Deno.mkdirSync(safety, { recursive: true });
  for (const set of header.contents) {
    await sqliteBackup(dbs[set], `${safety}/${set}.db`);
  }

  for (const set of header.contents) {
    const path = `${dbs.dir}/${set}.db`;
    dbs[set].close();
    for (const suffix of ["-wal", "-shm"]) {
      try {
        Deno.removeSync(path + suffix);
      } catch { /* not present */ }
    }
    Deno.copyFileSync(verified[set], path);
    Deno.removeSync(verified[set]);
    const fresh = openDatabase(path);
    migrate(fresh, set);
    dbs[set] = fresh;
  }
  return { restored: header.contents, safety_copy: safety, backup_created_at: header.created_at };
}
