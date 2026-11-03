/** Background evaluation: triggers, claim reviews, balance-update reminders, price refresh. */
import { type Databases, type DB, getSetting, type Row, transaction } from "../db/db.ts";
import { uuidv7 } from "../lib/ids.ts";
import * as d from "../lib/decimal.ts";
import { addDays, dateFromMs, today } from "../lib/dates.ts";
import { averageCost, getTrade, openQty } from "./assets.ts";
import { createNotification, hasOpenNotification } from "./notifications.ts";
import { latestPrice, refreshPrices, type RefreshResult } from "./prices.ts";
import type { AfterDaysParams, DateParams, PctParams } from "./theses.ts";

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
      const price = latestPrice(cache, link.provider_symbol as string);
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
  }
  return null;
}

export function evaluateTriggers(data: DB, cache: DB, todayStr: string): number {
  const tz = getSetting(data, "time_zone");
  const triggers = data.prepare(
    `SELECT g.* FROM triggers g JOIN theses t ON t.id = g.thesis_id
     WHERE g.status = 'active' AND t.status IN ('active','triggered')`,
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
    `SELECT c.*, t.title AS thesis_title FROM claims c JOIN theses t ON t.id = c.thesis_id
     WHERE c.status = 'active' AND t.status IN ('draft','active','triggered') AND c.next_review_on <= ?`,
  ).all(todayStr);
  let n = 0;
  for (const c of due) {
    if (hasOpenNotification(data, "claim_review_due", "claim", c.id as string)) continue;
    createNotification(data, {
      kind: "claim_review_due",
      title: `Review claim: ${c.statement}`,
      body: `Is this still true for "${c.thesis_title}"?`,
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
    "SELECT * FROM accounts WHERE archived_at IS NULL AND update_every_days IS NOT NULL AND auto_update = 0",
  ).all();
  let n = 0;
  for (const a of accounts) {
    const last = data.prepare(
      "SELECT max(as_of) AS as_of FROM account_snapshots WHERE account_id = ?",
    ).get(a.id as string) as Row;
    const since = (last.as_of as string | null) ?? dateFromMs(Number(a.created_at), tz);
    if (addDays(since, Number(a.update_every_days)) > todayStr) continue;
    if (hasOpenNotification(data, "balance_update_due", "account", a.id as string)) continue;
    createNotification(data, {
      kind: "balance_update_due",
      title: `Update the balance of ${a.name}`,
      body: last.as_of ? `Last updated ${last.as_of}.` : "No balance recorded yet.",
      refType: "account",
      refId: a.id as string,
    });
    n++;
  }
  return n;
}

/** Instruments worth pricing: those held (open quantity) or linked to an active thesis. */
export function instrumentsToPrice(data: DB): { provider_symbol: string; currency: string }[] {
  return data.prepare(
    `SELECT DISTINCT i.provider_symbol, i.currency FROM instruments i
     JOIN assets a ON a.instrument_id = i.id
     WHERE a.archived_at IS NULL AND (
       EXISTS (SELECT 1 FROM trades b WHERE b.asset_id = a.id AND b.side = 'buy'
               AND CAST(b.quantity AS REAL) > ifnull((SELECT sum(CAST(s.quantity AS REAL)) FROM sale_allocations s WHERE s.buy_trade_id = b.id), 0))
       OR EXISTS (SELECT 1 FROM thesis_links l JOIN theses t ON t.id = l.thesis_id
                  WHERE l.asset_id = a.id AND l.unlinked_at IS NULL AND t.status IN ('active','triggered'))
     )`,
  ).all() as { provider_symbol: string; currency: string }[];
}

export interface JobReport {
  ran_at: number;
  prices: RefreshResult;
  triggers_fired: number;
  claim_reviews: number;
  balance_reminders: number;
}

export async function runJobs(dbs: Databases, fetchFn: typeof fetch = fetch): Promise<JobReport> {
  const tz = getSetting(dbs.data, "time_zone");
  const todayStr = today(tz);
  const utcDay = new Date().toISOString().slice(0, 10);
  const prices = await refreshPrices(dbs.data, dbs.cache, instrumentsToPrice(dbs.data), utcDay, fetchFn);
  return {
    ran_at: Date.now(),
    prices,
    triggers_fired: evaluateTriggers(dbs.data, dbs.cache, todayStr),
    claim_reviews: queueClaimReviews(dbs.data, todayStr),
    balance_reminders: queueBalanceUpdates(dbs.data, todayStr),
  };
}
