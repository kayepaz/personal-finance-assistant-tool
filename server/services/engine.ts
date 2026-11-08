/** Background evaluation: triggers, claim reviews, balance-update reminders, price refresh. */
import { type Databases, type DB, getSetting, type Row, transaction } from "../db/db.ts";
import { uuidv7 } from "../lib/ids.ts";
import * as d from "../lib/decimal.ts";
import { addDays, dateFromMs, today } from "../lib/dates.ts";
import { averageCost, getTrade, openQty } from "./assets.ts";
import { createNotification, hasOpenNotification } from "./notifications.ts";
import { closesSince, currentPrice, refreshPrices, type RefreshResult } from "./prices.ts";
import { currenciesInUse, type FxResult, refreshFx } from "./fx.ts";
import { balanceSheet, recordNetWorth } from "./valuation.ts";
import { dispatch, type DispatchResult } from "./channels.ts";
import type { AfterDaysParams, DateParams, PctParams, TargetParams, TrailingParams } from "./triggers.ts";

interface Evaluation {
  fire: boolean;
  observed: Row;
  title: string;
  body: string;
}

function evaluate(
  trigger: Row,
  link: Row,
  params: Row,
  cache: DB,
  data: DB,
  todayStr: string,
  tz?: string,
): Evaluation | null {
  const what = `${link.asset_name}${link.buy_date ? ` (bought ${link.buy_date})` : ""}`;
  switch (trigger.type) {
    case "sell_on_date": {
      const p = params as unknown as DateParams;
      return {
        fire: todayStr >= p.date,
        observed: { today: todayStr, date: p.date },
        title: `Sell date reached: ${what}`,
        body: `Your thesis "${link.thesis_title}" planned to sell on ${p.date}.`,
      };
    }
    case "sell_after_days": {
      const p = params as unknown as AfterDaysParams;
      const start = p.from === "trigger_created"
        ? dateFromMs(Number(trigger.created_at), tz)
        : (link.buy_date as string | null) ?? dateFromMs(Number(link.linked_at), tz);
      const due = addDays(start, p.days);
      return {
        fire: todayStr >= due,
        observed: { today: todayStr, start, due },
        title: `Holding period reached: ${what}`,
        body: `Your thesis "${link.thesis_title}" planned to sell ${p.days} days after ${start} (${due}).`,
      };
    }
    case "pct_change": {
      const p = params as unknown as PctParams;
      if (!link.provider_symbol) return null; // no market price for this asset
      const price = currentPrice(data, cache, link.provider_symbol as string);
      if (!price) return null;
      let baseline: string | undefined;
      if (p.baseline === "fixed") baseline = p.fixed_price;
      else if (p.baseline === "purchase_price" && link.buy_price) baseline = link.buy_price as string;
      else baseline = averageCost(data, link.asset_id as string);
      if (!baseline || d.sign(baseline) <= 0) return null;
      const change = d.pctChange(baseline, price.close as string);
      const threshold = p.direction === "up" ? p.percent : d.mul(p.percent, "-1");
      const fire = p.direction === "up" ? d.cmp(change, threshold) >= 0 : d.cmp(change, threshold) <= 0;
      const verb = p.direction === "up" ? "risen" : "fallen";
      return {
        fire,
        observed: {
          price: price.close,
          price_date: price.price_date,
          baseline,
          baseline_kind: p.baseline,
          change_pct: change,
        },
        title: `${link.asset_name} has ${verb} ${d.round(change.replace("-", ""), 2)}%`,
        body:
          `Price ${price.close} on ${price.price_date} vs baseline ${d.round(baseline, 4)} (${
            p.baseline.replace("_", " ")
          }). ` +
          `Your thesis "${link.thesis_title}" set a ${
            p.direction === "up" ? "+" : "-"
          }${p.percent}% trigger.`,
      };
    }
    case "price_target": {
      const p = params as unknown as TargetParams;
      if (!link.provider_symbol) return null;
      const price = currentPrice(data, cache, link.provider_symbol as string);
      if (!price) return null;
      const above = p.direction === "at_or_above";
      const cmp = d.cmp(price.close as string, p.price);
      return {
        fire: above ? cmp >= 0 : cmp <= 0,
        observed: { price: price.close, price_date: price.price_date, target: p.price },
        title: `${link.asset_name} ${above ? "reached" : "fell to"} ${p.price}`,
        body:
          `Close ${price.close} on ${price.price_date}. Your thesis "${link.thesis_title}" planned to sell ` +
          `${above ? "at or above" : "at or below"} ${p.price}.`,
      };
    }
    case "trailing_stop": {
      const p = params as unknown as TrailingParams;
      if (!link.provider_symbol) return null;
      const symbol = link.provider_symbol as string;
      const price = currentPrice(data, cache, symbol);
      if (!price) return null;
      const mark = updateHighWaterMark(data, cache, trigger, link, price, tz);
      const stop = d.mul(mark.high, d.sub("1", d.div(p.percent, "100", 10)));
      const drop = d.pctChange(mark.high, price.close as string);
      return {
        fire: d.cmp(price.close as string, stop) <= 0,
        observed: {
          price: price.close,
          price_date: price.price_date,
          high: mark.high,
          high_date: mark.high_date,
          stop: d.round(stop, 4),
          change_pct: drop,
        },
        title: `${link.asset_name} is ${d.round(drop.replace("-", ""), 2)}% below its high`,
        body:
          `Close ${price.close} on ${price.price_date} vs high ${mark.high} on ${mark.high_date} (daily closes). ` +
          `Your thesis "${link.thesis_title}" set a ${p.percent}% trailing stop at ${d.round(stop, 2)}.`,
      };
    }
  }
  return null;
}

/**
 * Highest daily close since the holding started (purchase date, or when an asset-level link was made),
 * never lower than the purchase price. Kept in data.db and only ever raised.
 */
function updateHighWaterMark(
  data: DB,
  cache: DB,
  trigger: Row,
  link: Row,
  price: Row,
  tz?: string,
): { high: string; high_date: string } {
  const stored = data.prepare(
    "SELECT high, high_date FROM trailing_highs WHERE trigger_id = ? AND link_id = ?",
  )
    .get(trigger.id as string, link.id as string) as Row | undefined;
  let high = stored?.high as string | undefined;
  let highDate = stored?.high_date as string | undefined;
  if (!stored) {
    const start = (link.buy_date as string | null) ?? dateFromMs(Number(link.linked_at), tz);
    if (link.buy_price) {
      high = link.buy_price as string;
      highDate = start;
    }
    const closes = closesSince(data, cache, link.provider_symbol as string, start);
    for (const c of closes) {
      if (!high || d.cmp(c.close as string, high) > 0) {
        high = c.close as string;
        highDate = c.price_date as string;
      }
    }
  }
  if (!high || d.cmp(price.close as string, high) > 0) {
    high = price.close as string;
    highDate = price.price_date as string;
  }
  if (!stored || stored.high !== high) {
    data.prepare(
      `INSERT INTO trailing_highs(trigger_id, link_id, high, high_date, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(trigger_id, link_id) DO UPDATE SET high = excluded.high, high_date = excluded.high_date,
         updated_at = excluded.updated_at`,
    ).run(trigger.id as string, link.id as string, high, highDate!, Date.now());
  }
  return { high, high_date: highDate! };
}

export function evaluateTriggers(data: DB, cache: DB, todayStr: string): number {
  const tz = getSetting(data, "time_zone");
  const triggers = data.prepare(
    `SELECT g.*, tt.thesis_id FROM thesis_triggers tt
     JOIN triggers g ON g.id = tt.trigger_id
     JOIN theses t ON t.id = tt.thesis_id
     WHERE tt.detached_at IS NULL AND g.status = 'active' AND t.status IN ('active','triggered')`,
  ).all();
  let fired = 0;
  for (const trigger of triggers) {
    const params = JSON.parse(trigger.params as string) as Row;
    const links = data.prepare(
      `SELECT l.*, t.title AS thesis_title, a.name AS asset_name, a.tracking, i.provider_symbol,
              b.trade_date AS buy_date, b.price AS buy_price
       FROM thesis_links l
       JOIN theses t ON t.id = l.thesis_id
       JOIN assets a ON a.id = l.asset_id
       LEFT JOIN instruments i ON i.id = a.instrument_id
       LEFT JOIN trades b ON b.id = l.buy_trade_id
       WHERE l.thesis_id = ? AND l.unlinked_at IS NULL`,
    ).all(trigger.thesis_id as string);

    for (const link of links) {
      // Fully sold purchases have nothing left to act on.
      if (link.buy_trade_id && d.sign(openQty(data, getTrade(data, link.buy_trade_id as string))) === 0) {
        continue;
      }
      // One alert per trigger version per link: adjusting the trigger re-arms it.
      const already = data.prepare(
        "SELECT 1 FROM trigger_firings WHERE trigger_id = ? AND link_id = ? AND (closed_at IS NULL OR fired_at >= ?)",
      ).get(trigger.id as string, link.id as string, Number(trigger.updated_at));
      if (already) continue;

      const ev = evaluate(trigger, link, params, cache, data, todayStr, tz);
      if (!ev?.fire) continue;
      transaction(data, () => {
        const notificationId = createNotification(data, {
          kind: "trigger_fired",
          title: trigger.label ? `${trigger.label}: ${ev.title}` : ev.title,
          body: ev.body,
          refType: "trigger",
          refId: trigger.id as string,
        });
        data.prepare(
          `INSERT INTO trigger_firings(id, trigger_id, link_id, observed, fired_at, notification_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          uuidv7(),
          trigger.id as string,
          link.id as string,
          JSON.stringify(ev.observed),
          Date.now(),
          notificationId,
        );
        data.prepare(
          "UPDATE theses SET status = 'triggered', updated_at = ? WHERE id = ? AND status = 'active'",
        )
          .run(Date.now(), trigger.thesis_id as string);
      });
      fired++;
    }
  }
  return fired;
}

export function queueClaimReviews(data: DB, todayStr: string): number {
  const due = data.prepare(
    `SELECT c.*, group_concat(t.title, '", "') AS thesis_titles, count(t.id) AS thesis_count
     FROM claims c
     JOIN thesis_claims tc ON tc.claim_id = c.id AND tc.detached_at IS NULL
     JOIN theses t ON t.id = tc.thesis_id AND t.status IN ('draft','active','triggered')
     WHERE c.status = 'active' AND c.next_review_on <= ?
     GROUP BY c.id`,
  ).all(todayStr);
  let n = 0;
  for (const c of due) {
    if (hasOpenNotification(data, "claim_review_due", "claim", c.id as string)) continue;
    createNotification(data, {
      kind: "claim_review_due",
      title: `Review claim: ${c.statement}`,
      body: Number(c.thesis_count) > 1
        ? `Is this still true? It supports ${c.thesis_count} theses: "${c.thesis_titles}".`
        : `Is this still true for "${c.thesis_titles}"?`,
      refType: "claim",
      refId: c.id as string,
    });
    n++;
  }
  return n;
}

export function queueBalanceUpdates(data: DB, todayStr: string): number {
  const tz = getSetting(data, "time_zone");
  const accounts = data.prepare(
    "SELECT * FROM accounts WHERE archived_at IS NULL AND update_every_days IS NOT NULL",
  ).all();
  let n = 0;
  for (const a of accounts) {
    const last = (a.kind === "real_estate"
      // Real estate: due when the least recently updated house or mortgage is due.
      ? data.prepare(
        `SELECT min(latest) AS as_of FROM (SELECT max(v.as_of) AS latest FROM assets x
           JOIN asset_values v ON v.asset_id = x.id WHERE x.account_id = ? AND x.archived_at IS NULL GROUP BY x.id)`,
      ).get(a.id as string)
      : data.prepare(
        "SELECT max(as_of) AS as_of FROM account_snapshots WHERE account_id = ? AND kind = ?",
      ).get(a.id as string, a.kind === "self_directed" ? "cash" : "value")) as Row;
    const since = (last.as_of as string | null) ?? dateFromMs(Number(a.created_at), tz);
    if (addDays(since, Number(a.update_every_days)) > todayStr) continue;
    if (hasOpenNotification(data, "balance_update_due", "account", a.id as string)) continue;
    createNotification(data, {
      kind: "balance_update_due",
      title: a.kind === "self_directed"
        ? `Update the cash balance of ${a.name}`
        : a.kind === "real_estate"
        ? `Update the house values and mortgage balances in ${a.name}`
        : `Update the balance of ${a.name}`,
      body: last.as_of ? `Last updated ${last.as_of}.` : "No balance recorded yet.",
      refType: "account",
      refId: a.id as string,
    });
    n++;
  }
  return n;
}

/** Instruments worth pricing: those held (open quantity) or linked to an active thesis. */
export function instrumentsToPrice(data: DB): { provider_symbol: string; currency: string; kind: string }[] {
  return data.prepare(
    `SELECT DISTINCT i.provider_symbol, i.currency, i.kind FROM instruments i
     JOIN assets a ON a.instrument_id = i.id
     WHERE a.archived_at IS NULL AND i.price_source = 'auto' AND (
       EXISTS (SELECT 1 FROM trades b WHERE b.asset_id = a.id AND b.side = 'buy'
               AND CAST(b.quantity AS REAL) > ifnull((SELECT sum(CAST(s.quantity AS REAL)) FROM sale_allocations s WHERE s.buy_trade_id = b.id), 0))
       OR EXISTS (SELECT 1 FROM thesis_links l JOIN theses t ON t.id = l.thesis_id
                  WHERE l.asset_id = a.id AND l.unlinked_at IS NULL AND t.status IN ('active','triggered'))
     )`,
  ).all() as { provider_symbol: string; currency: string; kind: string }[];
}

export interface JobReport {
  ran_at: number;
  prices: RefreshResult;
  fx: FxResult;
  net_worth: string;
  delivered: DispatchResult;
  triggers_fired: number;
  claim_reviews: number;
  balance_reminders: number;
}

export async function runJobs(dbs: Databases, fetchFn: typeof fetch = fetch): Promise<JobReport> {
  const tz = getSetting(dbs.data, "time_zone");
  const todayStr = today(tz);
  const utcDay = new Date().toISOString().slice(0, 10);
  const prices = await refreshPrices(dbs.data, dbs.cache, instrumentsToPrice(dbs.data), utcDay, fetchFn);
  const base = getSetting(dbs.data, "base_currency") ?? "CAD";
  const fx = await refreshFx(dbs.data, dbs.cache, currenciesInUse(dbs.data), base, utcDay, fetchFn);
  const sheet = balanceSheet(dbs.data, dbs.cache, todayStr);
  recordNetWorth(dbs.data, sheet);
  const triggersFired = evaluateTriggers(dbs.data, dbs.cache, todayStr);
  const claimReviews = queueClaimReviews(dbs.data, todayStr);
  const balanceReminders = queueBalanceUpdates(dbs.data, todayStr);
  const delivered = await dispatch(dbs.data, fetchFn);
  return {
    ran_at: Date.now(),
    prices,
    fx,
    net_worth: sheet.totals.net_worth,
    triggers_fired: triggersFired,
    claim_reviews: claimReviews,
    balance_reminders: balanceReminders,
    delivered,
  };
}
