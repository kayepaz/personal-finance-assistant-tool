/** Database sizes for the Settings page. */
import type { Databases, DB, Row } from "../db/db.ts";
import { notFound } from "../lib/http.ts";

export interface DbStats {
  name: "data" | "cache";
  bytes: number;
  tables: number;
  rows: number;
}

function fileSize(path: string): number {
  try {
    return Deno.statSync(path).size;
  } catch {
    return 0;
  }
}

function stats(db: DB, name: "data" | "cache", dir?: string): DbStats {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map((t) => t.name as string);
  let rows = 0;
  for (const t of tables) {
    rows += Number((db.prepare(`SELECT count(*) AS n FROM "${t.replaceAll('"', '""')}"`).get() as Row).n);
  }
  const pages = db.prepare("SELECT page_count * page_size AS b FROM pragma_page_count(), pragma_page_size()")
    .get() as Row;
  // On disk, include the write-ahead log, which holds recent changes until SQLite folds them in.
  const bytes = dir ? fileSize(`${dir}/${name}.db`) + fileSize(`${dir}/${name}.db-wal`) : Number(pages.b);
  return { name, bytes, tables: tables.length, rows };
}

export interface PreRestoreCopy {
  name: string;
  bytes: number;
  created_at: number | null;
}

export interface StorageReport {
  databases: DbStats[];
  pre_restore: { count: number; bytes: number; folders: PreRestoreCopy[] };
}

const PRE_RESTORE_RE = /^pre-restore-\d{8}T\d{6}$/;

function preRestoreFolders(dir?: string): PreRestoreCopy[] {
  if (!dir) return [];
  const out: PreRestoreCopy[] = [];
  try {
    for (const e of Deno.readDirSync(dir)) {
      if (!e.isDirectory || !PRE_RESTORE_RE.test(e.name)) continue;
      let bytes = 0;
      for (const f of Deno.readDirSync(`${dir}/${e.name}`)) {
        if (f.isFile) bytes += fileSize(`${dir}/${e.name}/${f.name}`);
      }
      // Folder names carry the restore time: pre-restore-YYYYMMDDTHHMMSS (UTC).
      const m = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(e.name)!;
      out.push({ name: e.name, bytes, created_at: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) });
    }
  } catch { /* data dir unreadable: report nothing */ }
  return out.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
}

export function storageReport(dbs: Databases): StorageReport {
  const folders = preRestoreFolders(dbs.dir);
  return {
    databases: [stats(dbs.data, "data", dbs.dir), stats(dbs.cache, "cache", dbs.dir)],
    pre_restore: { count: folders.length, bytes: folders.reduce((n, f) => n + f.bytes, 0), folders },
  };
}

/** Delete one pre-restore copy, or all of them when `name` is omitted. Returns how many were removed. */
export function deletePreRestore(dbs: Databases, name?: string): number {
  if (!dbs.dir) return 0;
  const targets = preRestoreFolders(dbs.dir).filter((f) => !name || f.name === name);
  if (name && !targets.length) throw notFound("No such pre-restore copy");
  for (const f of targets) Deno.removeSync(`${dbs.dir}/${f.name}`, { recursive: true });
  return targets.length;
}
