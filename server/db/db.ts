import { DatabaseSync } from "node:sqlite";

export type DB = DatabaseSync;
export type Row = Record<string, unknown>;

export interface Databases {
  data: DB;
  cache: DB;
}

const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url);

export function openDatabase(path: string): DB {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
  }
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

/** Apply numbered `NNNN_name.sql` files in order, tracked by PRAGMA user_version. Returns versions applied. */
export function migrate(db: DB, set: "data" | "cache"): number[] {
  const dir = new URL(`${set}/`, MIGRATIONS_DIR);
  const files = [...Deno.readDirSync(dir)]
    .filter((e) => e.isFile && /^\d{4}_.+\.sql$/.test(e.name))
    .map((e) => e.name)
    .sort();

  const current = Number((db.prepare("PRAGMA user_version").get() as Row).user_version);
  const applied: number[] = [];
  for (const name of files) {
    const version = Number(name.slice(0, 4));
    if (version <= current) continue;
    const sql = Deno.readTextFileSync(new URL(name, dir));
    transaction(db, () => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version}`);
    });
    applied.push(version);
  }
  const fkProblems = db.prepare("PRAGMA foreign_key_check").all();
  if (fkProblems.length) {
    throw new Error(`Foreign key check failed after migration: ${JSON.stringify(fkProblems)}`);
  }
  return applied;
}

let depth = 0;

/** Run `fn` in a transaction (nested calls use savepoints). */
export function transaction<T>(db: DB, fn: () => T): T {
  const sp = `sp_${depth}`;
  db.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${sp}`);
  depth++;
  try {
    const result = fn();
    depth--;
    db.exec(depth === 0 ? "COMMIT" : `RELEASE ${sp}`);
    return result;
  } catch (err) {
    depth--;
    db.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw err;
  }
}

export function openAll(dataDir: string): Databases {
  Deno.mkdirSync(dataDir, { recursive: true });
  const data = openDatabase(`${dataDir}/data.db`);
  const cache = openDatabase(`${dataDir}/cache.db`);
  migrate(data, "data");
  migrate(cache, "cache");
  return { data, cache };
}

export function openInMemory(): Databases {
  const data = openDatabase(":memory:");
  const cache = openDatabase(":memory:");
  migrate(data, "data");
  migrate(cache, "cache");
  return { data, cache };
}

export function getSetting(db: DB, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as Row | undefined;
  return row?.value as string | undefined;
}

export function setSetting(db: DB, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .run(key, value);
}
