/** Database sizes for the Settings page. */
import type { Databases, DB, Row } from "../db/db.ts";

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

export interface StorageReport {
  databases: DbStats[];
  pre_restore: { count: number; bytes: number };
}

export function storageReport(dbs: Databases): StorageReport {
  const pre = { count: 0, bytes: 0 };
  if (dbs.dir) {
    try {
      for (const e of Deno.readDirSync(dbs.dir)) {
        if (!e.isDirectory || !e.name.startsWith("pre-restore-")) continue;
        pre.count++;
        for (const f of Deno.readDirSync(`${dbs.dir}/${e.name}`)) {
          if (f.isFile) pre.bytes += fileSize(`${dbs.dir}/${e.name}/${f.name}`);
        }
      }
    } catch { /* data dir unreadable: report nothing */ }
  }
  return {
    databases: [stats(dbs.data, "data", dbs.dir), stats(dbs.cache, "cache", dbs.dir)],
    pre_restore: pre,
  };
}
