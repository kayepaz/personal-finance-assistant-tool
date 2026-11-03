/**
 * Balance sheet, net-worth history and allocation reports. All values are approximate by design and reported
 * in the base currency chosen at install.
 */
import { type DB, getSetting, type Row } from "../db/db.ts";
import * as d from "../lib/decimal.ts";
import { addDays, daysBetween } from "../lib/dates.ts";
import { latestSnapshot, LIABILITY_KINDS } from "./accounts.ts";
import { openBuys } from "./assets.ts";
import { latestPrice } from "./prices.ts";
import { convert } from "./fx.ts";

const PRICE_STALE_DAYS = 7;
const r2 = (x: string) => d.round(x, 2);

export interface Holding {
  asset_id: string;
  name: string;
  quantity: string;
  currency: string;
  price: string | null;
  price_date: string | null;
  value_native: string;
  value_base: string | null;
  priced: boolean;
}

export interface AccountValue {
  id: string;
  name: string;
  kind: string;
  tags: string[];
  is_liability: boolean;
  currency: string;
  value_native: string | null; // account currency (holdings converted into it where possible)
  value_base: string | null; // base currency; null = could not value
  as_of: string | null;
  stale: boolean;
  warnings: string[];
  holdings: Holding[];
  cash_native: string | null;
}

export interface BalanceSheet {
  base_currency: string;
  as_of: string;
  accounts: AccountValue[];
  totals: { assets: string; liabilities: string; net_worth: string };
  warnings: string[];
}

function valueSelfDirected(data: DB, cache: DB, a: Row, base: string, todayStr: string): AccountValue {
  const out = blank(a);
  const assets = data.prepare(
    `SELECT a.id, a.name, i.provider_symbol, i.currency FROM assets a JOIN instruments i ON i.id = a.instrument_id
     WHERE a.account_id = ? AND a.archived_at IS NULL AND a.tracking = 'trades'`,
  ).all(a.id as string);
  let totalBase = "0";
  let totalNative = "0";
  let ok = true;
  for (const asset of assets) {
    const open = openBuys(data, asset.id as string);
    const qty = d.sum(open.map((b) => b.open_quantity));
    if (d.sign(qty) === 0) continue;
    const cur = asset.currency as string;
    const p = latestPrice(cache, asset.provider_symbol as string);
    let native: string;
    if (p) {
      native = d.mul(qty, p.close as string);
      if (daysBetween(p.price_date as string, todayStr) > PRICE_STALE_DAYS) {
        out.stale = true;
        out.warnings.push(`${asset.name}: last price is from ${p.price_date}`);
      }
    } else {
      native = d.sum(open.map((b) => d.mul(b.open_quantity, b.price)));
      out.warnings.push(`${asset.name}: no market price yet, valued at cost`);
    }
    const inBase = convert(cache, native, cur, base);
    const inAccount = convert(cache, native, cur, out.currency);
    if (inBase === undefined) {
      ok = false;
      out.warnings.push(`${asset.name}: no ${cur}→${base} exchange rate`);
    } else totalBase = d.add(totalBase, inBase);
    if (inAccount !== undefined) totalNative = d.add(totalNative, inAccount);
    out.holdings.push({
      asset_id: asset.id as string,
      name: asset.name as string,
      quantity: qty,
      currency: cur,
      price: (p?.close as string) ?? null,
      price_date: (p?.price_date as string) ?? null,
      value_native: r2(native),
      value_base: inBase === undefined ? null : r2(inBase),
      priced: !!p,
    });
  }
  const cash = latestSnapshot(data, a.id as string, "cash");
  if (cash) {
    out.cash_native = cash.amount as string;
    out.as_of = cash.as_of as string;
    totalNative = d.add(totalNative, cash.amount as string);
    const cashBase = convert(cache, cash.amount as string, out.currency, base);
    if (cashBase === undefined) {
      ok = false;
      out.warnings.push(`Cash: no ${out.currency}→${base} exchange rate`);
    } else totalBase = d.add(totalBase, cashBase);
    checkStale(out, a, cash.as_of as string, todayStr);
  }
  out.value_native = r2(totalNative);
  out.value_base = ok ? r2(totalBase) : null;
  return out;
}

function valueBySnapshot(data: DB, cache: DB, a: Row, base: string, todayStr: string): AccountValue {
  const out = blank(a);
  const snap = latestSnapshot(data, a.id as string, "value");
  if (!snap) {
    out.warnings.push("No balance recorded yet");
    return out;
  }
  let amount = snap.amount as string;
  if (out.is_liability) amount = amount.replace(/^-/, ""); // amounts owed are stored and shown as positive
  out.value_native = r2(amount);
  out.as_of = snap.as_of as string;
  const inBase = convert(cache, amount, out.currency, base);
  if (inBase === undefined) out.warnings.push(`No ${out.currency}→${base} exchange rate`);
  else out.value_base = r2(inBase);
  checkStale(out, a, snap.as_of as string, todayStr);
  return out;
}

function blank(a: Row): AccountValue {
  return {
    id: a.id as string,
    name: a.name as string,
    kind: a.kind as string,
    tags: JSON.parse(a.tags as string),
    is_liability: LIABILITY_KINDS.has(a.kind as string),
    currency: a.currency as string,
    value_native: null,
    value_base: null,
    as_of: null,
    stale: false,
    warnings: [],
    holdings: [],
    cash_native: null,
  };
}

function checkStale(out: AccountValue, a: Row, asOf: string, todayStr: string) {
  const every = a.update_every_days as number | null;
  if (every && addDays(asOf, every) < todayStr) {
    out.stale = true;
    out.warnings.push(`Balance last updated ${asOf}; due every ${every} days`);
  }
}

export function balanceSheet(data: DB, cache: DB, todayStr: string): BalanceSheet {
  const base = getSetting(data, "base_currency") ?? "CAD";
  const accounts = data.prepare("SELECT * FROM accounts WHERE archived_at IS NULL ORDER BY name").all();
  const values = accounts.map((a) =>
    a.kind === "self_directed"
      ? valueSelfDirected(data, cache, a, base, todayStr)
      : valueBySnapshot(data, cache, a, base, todayStr)
  );
  let assets = "0", liabilities = "0";
  const warnings: string[] = [];
  for (const v of values) {
    if (v.value_base === null) {
      warnings.push(`${v.name} is not included in the totals: ${v.warnings.at(-1) ?? "no value"}`);
      continue;
    }
    if (v.is_liability) liabilities = d.add(liabilities, v.value_base);
    else assets = d.add(assets, v.value_base);
  }
  return {
    base_currency: base,
    as_of: todayStr,
    accounts: values,
    totals: { assets: r2(assets), liabilities: r2(liabilities), net_worth: r2(d.sub(assets, liabilities)) },
    warnings,
  };
}

// ---------------------------------------------------------------- history

/** Upsert this month's row from a freshly computed balance sheet. */
export function recordNetWorth(data: DB, sheet: BalanceSheet): void {
  const detail = sheet.accounts.map((a) => ({
    id: a.id,
    name: a.name,
    is_liability: a.is_liability,
    value_base: a.value_base,
  }));
  data.prepare(
    `INSERT INTO net_worth_snapshots(month, as_of, base_currency, assets, liabilities, net_worth, detail, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(month) DO UPDATE SET as_of = excluded.as_of, base_currency = excluded.base_currency,
       assets = excluded.assets, liabilities = excluded.liabilities, net_worth = excluded.net_worth,
       detail = excluded.detail, updated_at = excluded.updated_at`,
  ).run(
    sheet.as_of.slice(0, 7),
    sheet.as_of,
    sheet.base_currency,
    sheet.totals.assets,
    sheet.totals.liabilities,
    sheet.totals.net_worth,
    JSON.stringify({ accounts: detail, warnings: sheet.warnings }),
    Date.now(),
  );
}

export interface MonthPoint {
  month: string;
  as_of: string;
  assets: string;
  liabilities: string;
  net_worth: string;
  change: string | null; // vs previous recorded month
  live: boolean; // current month computed now rather than stored
}

/** Stored months, with the current month replaced by the live value. */
export function netWorthHistory(data: DB, sheet: BalanceSheet, months = 24): MonthPoint[] {
  const rows = data.prepare(
    "SELECT * FROM net_worth_snapshots WHERE base_currency = ? ORDER BY month DESC LIMIT ?",
  ).all(sheet.base_currency, months).reverse();
  const current = sheet.as_of.slice(0, 7);
  const points: MonthPoint[] = rows.filter((r) => r.month !== current).map((r) => ({
    month: r.month as string,
    as_of: r.as_of as string,
    assets: r.assets as string,
    liabilities: r.liabilities as string,
    net_worth: r.net_worth as string,
    change: null,
    live: false,
  }));
  points.push({
    month: current,
    as_of: sheet.as_of,
    assets: sheet.totals.assets,
    liabilities: sheet.totals.liabilities,
    net_worth: sheet.totals.net_worth,
    change: null,
    live: true,
  });
  for (let i = 1; i < points.length; i++) {
    points[i].change = r2(d.sub(points[i].net_worth, points[i - 1].net_worth));
  }
  return points;
}

// ---------------------------------------------------------------- allocation

export interface Slice {
  id: string | null;
  label: string;
  value: string; // base currency
  pct: string;
}

export interface SplitNote {
  holding: string;
  account: string;
  detail: string; // e.g. "bought 2026-01-10" or "account value shared by 2 assets"
  theses: string[];
  value: string; // total value that was divided
  each: string;
}

function pctOf(part: string, total: string): string {
  return d.sign(total) === 0 ? "0" : d.round(d.div(d.mul(part, "100"), total, 8), 1);
}

export function allocationByAccount(sheet: BalanceSheet): { total: string; slices: Slice[] } {
  const items = sheet.accounts.filter((a) =>
    !a.is_liability && a.value_base !== null && d.sign(a.value_base) > 0
  );
  const total = sheet.totals.assets;
  return {
    total,
    slices: items
      .map((a) => ({ id: a.id, label: a.name, value: a.value_base!, pct: pctOf(a.value_base!, total) }))
      .sort((x, y) => d.cmp(y.value, x.value)),
  };
}

/**
 * Share of total assets by thesis. Each linked purchase contributes its current value; a purchase linked to
 * several open theses is split evenly between them (and recorded as a split note). Value-tracked assets take
 * their account's value, divided evenly among that account's value-tracked assets.
 */
export function allocationByThesis(
  data: DB,
  sheet: BalanceSheet,
): { total: string; slices: Slice[]; splits: SplitNote[] } {
  const byThesis = new Map<string, { label: string; value: string }>();
  const splits: SplitNote[] = [];
  const add = (id: string, label: string, v: string) => {
    const cur = byThesis.get(id) ?? { label, value: "0" };
    cur.value = d.add(cur.value, v);
    byThesis.set(id, cur);
  };
  const links = data.prepare(
    `SELECT l.thesis_id, l.asset_id, l.buy_trade_id, t.title, a.name AS asset_name, a.tracking, a.account_id,
            ac.name AS account_name, b.trade_date
     FROM thesis_links l
     JOIN theses t ON t.id = l.thesis_id AND t.status IN ('draft','active','triggered')
     JOIN assets a ON a.id = l.asset_id AND a.archived_at IS NULL
     JOIN accounts ac ON ac.id = a.account_id AND ac.archived_at IS NULL
     LEFT JOIN trades b ON b.id = l.buy_trade_id
     WHERE l.unlinked_at IS NULL`,
  ).all();

  // Group links by the thing being valued: a purchase, or a value-tracked asset.
  const groups = new Map<string, Row[]>();
  for (const l of links) {
    const key = l.buy_trade_id ? `buy:${l.buy_trade_id}` : `asset:${l.asset_id}`;
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const accounts = new Map(sheet.accounts.map((a) => [a.id, a]));

  for (const [key, group] of groups) {
    const first = group[0];
    const account = accounts.get(first.account_id as string);
    if (!account || account.is_liability) continue;
    let value: string | undefined;
    let detail = "";
    if (key.startsWith("buy:")) {
      const holding = account.holdings.find((h) => h.asset_id === first.asset_id);
      if (!holding || holding.value_base === null || d.sign(holding.quantity) === 0) continue;
      const buy = openBuys(data, first.asset_id as string).find((b) => b.id === first.buy_trade_id);
      if (!buy) continue; // fully sold
      value = d.div(d.mul(holding.value_base, buy.open_quantity), holding.quantity, 8);
      detail = `bought ${first.trade_date}`;
    } else {
      if (account.value_base === null) continue;
      const siblings = Number(
        (data.prepare(
          "SELECT count(*) AS n FROM assets WHERE account_id = ? AND tracking = 'value' AND archived_at IS NULL",
        ).get(first.account_id as string) as Row).n,
      );
      value = d.div(account.value_base, String(Math.max(siblings, 1)), 8);
      detail = siblings > 1 ? `account value shared evenly by ${siblings} assets` : "account value";
    }
    const each = d.div(value, String(group.length), 8);
    for (const l of group) add(l.thesis_id as string, l.title as string, each);
    if (group.length > 1) {
      splits.push({
        holding: first.asset_name as string,
        account: first.account_name as string,
        detail,
        theses: group.map((l) => l.title as string),
        value: r2(value),
        each: r2(each),
      });
    }
  }

  const total = sheet.totals.assets;
  const slices: Slice[] = [...byThesis.entries()]
    .map(([id, s]) => ({ id, label: s.label, value: r2(s.value), pct: pctOf(s.value, total) }))
    .sort((x, y) => d.cmp(y.value, x.value));
  const assigned = d.sum(slices.map((s) => s.value));
  const rest = d.sub(total, assigned);
  if (d.sign(rest) > 0) {
    slices.push({ id: null, label: "Not in any thesis", value: r2(rest), pct: pctOf(rest, total) });
  }
  return { total, slices, splits };
}
