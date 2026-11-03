# PFAT — Specification (v0.1)

PFAT (Personal Finance Assistant Tool) tracks **why** you own each self-directed investment and **when** you
plan to exit it, alongside an approximate balance sheet of everything you own and owe.

It is **not a ledger**. Balances are approximate. Taxes, fees and jurisdiction rules are noted, never
calculated.

## Architecture

| Piece           | Choice                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| Server          | Deno, single process, zero third-party dependencies                                                     |
| Storage         | Two SQLite files on the server: `data.db` (precious user data) and `cache.db` (rebuildable market data) |
| Client          | PWA served by the server; plain TypeScript, types stripped on the fly (no build step)                   |
| Users           | One user per server instance; any number of client devices                                              |
| Auth            | Passphrase set at install → PBKDF2-SHA256 hash; each device gets a revocable session token              |
| Market data     | Alpha Vantage and Finnhub, user-supplied keys, daily-quota aware                                        |
| Background work | In-process scheduler on the server (prices, triggers, reviews)                                          |

### Privacy rules

- All user data stays in `data.db` on the user's server.
- Anything that leaves the server (market-data lookups, webhooks, ntfy, email) requires an explicit consent
  prompt that says what is sent and where. Consent is stored and revocable.
- Market-data requests send only ticker symbols, never holdings or quantities.

## Domain

- **Account** — a container with a kind: self-directed, managed portfolio, real estate, cash, credit card,
  line of credit, other. Has a currency, optional tags (TFSA, RRSP, non-registered…), free-text jurisdiction
  notes, and a "remind me to update every X days" setting. Liabilities are accounts whose kind is a liability.
  A mortgage (line of credit / other liability) may link to a property account.
- **Instrument** — something with a market price (ticker + exchange + currency + provider symbol).
- **Asset** — an instrument (or a named non-market item, e.g. a house) held in one account. AAPL in a TFSA and
  AAPL in a margin account are two assets. Assets are tracked either by **trades** (self-directed) or by
  **value** (managed portfolios, real estate, art).
- **Trade** — a buy or sell of a trade-tracked asset. Every sell names the buy(s) it closes (specific
  identification) via **sale allocations**.
- **Thesis** — why you hold something. Lifecycle: Draft → Active → Triggered → Closed / Abandoned. On close,
  the user writes a retrospective and an outcome (played out / partly / wrong / unclear).
- **Thesis link** — ties a thesis to a **buy trade** (trade-tracked assets) or to an **asset** (value-tracked
  assets). Many-to-many: a buy can serve several theses; a thesis spans many buys and assets. Links can be
  removed with a reason.
- **Claim** — a qualitative statement to re-check every X days. Each review records a verdict and a note.
- **Reasoning entry** — free-form notes on a thesis. Not testable.
- **Trigger** — a quantitative rule on a thesis, evaluated per thesis link. Types in v0.1:
  - `sell_on_date` — fires on a date.
  - `sell_after_days` — fires X days after the linked purchase (or after the trigger was created).
  - `pct_change` — fires when price moves up/down X% from a baseline: average cost (default), the linked
    purchase price, or a fixed price (the UI prefills today's price).
  - Trailing stops (later) use daily closes and say so in the UI.
- **Revision** — every create/update of a thesis, link, claim or trigger appends a full snapshot with an
  optional "why I changed it" note. Nothing is overwritten.
- **Notification** — a to-do item, never passively dismissed. Kinds: trigger fired, claim review due, balance
  update due. Actions: adjust (edit the trigger/claim), record sale, snooze until a date, dismiss with a
  required reason, mark reviewed/updated. A fired trigger does not re-alert for the same link until its
  notification is resolved.
- **Balance snapshot** — a dated value for an account. Self-directed accounts are valued as positions × latest
  price + the latest manually entered cash. Months without an update carry the last value forward, flagged
  stale.

## Base currency

Chosen at install. Other currencies convert with cached FX rates.

## Notification delivery (v0.1)

In-app to-do page first. Webhook and ntfy (self-hostable) channels follow, each behind a consent prompt. Email
via the user's own SMTP comes later.

## Backups

Manual. User picks data, cache, or both. Always encrypted with a passphrase the user types (mandatory).
Device-bound keys are out of scope for now.

## Milestones

1. **v0.1 (this slice)** — install/login, accounts, instruments, assets, trades with sale allocation, theses,
   links, claims + reviews, reasoning, date and % triggers, revisions, notifications page, scheduler, price
   providers with quota tracking.
2. **v0.2** — balance sheet, snapshots, reports (balance sheet, monthly net-worth change, % of net worth pie
   by account and by thesis), FX conversion.
3. **v0.3** — encrypted backup/restore, webhook + ntfy channels with consent prompts, trailing stops.
