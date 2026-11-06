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
- **Instrument** — something with a price (ticker + exchange + currency + provider symbol). Its price source
  is _automatic_ (stocks and ETFs via `TIME_SERIES_DAILY`/Finnhub quote; crypto via Alpha Vantage
  `DIGITAL_CURRENCY_DAILY` in the instrument's currency, or Finnhub with an exchange symbol like
  `BINANCE:BTCUSDT`; metals via Alpha Vantage spot rates such as `XAU`) or _manual_ (art, property, coins).
  Prices the user records live in `data.db`; the newest date wins, and a manual price wins a tie. Instruments
  and trades can be edited: a buy's quantity can't drop below what's been sold, dates can't cross the sales
  they're tied to, and a sale's quantity changes by deleting and re-recording it.
- **Cash account** — a single balance with a dated history; no assets.
- **Deleting** — an account can be deleted once it holds no assets (its balance history goes with it); an
  asset once it has no trades and no active thesis links (its value history and past links go with it; thesis
  history keeps the revision records). The UI lists whatever must be removed first.
- **Real estate account** — holds only two kinds of asset: a **house** with a declared value and a
  **mortgage** with the amount owed. Each has its own dated value history (no automatic updates). The account
  has no cash or account-level balance; its value is always the sum of its houses minus its mortgages. A house
  can be part of a thesis (its declared value counts); a mortgage can't. Update reminders follow the least
  recently updated figure.
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
  Claims are a shared library: one claim can be attached to many theses, has one review schedule, and one
  review covers every thesis using it. Managed globally on the Claims page.
- **Reasoning entry** — free-form notes on a thesis. Not testable.
- **Trigger** — a quantitative rule, kept in a shared library and attachable to many theses. Editing a trigger
  changes it for every thesis using it; to change one thesis only, swap it for a different trigger there.
  Evaluated per thesis link of each thesis it is attached to. Managed globally on the Triggers page. Types:
  - `sell_on_date` — fires on a date.
  - `sell_after_days` — fires X days after the linked purchase (or after the trigger was created).
  - `pct_change` — fires when price moves up/down X% from a baseline: average cost (default), the linked
    purchase price, or a fixed price (the UI prefills today's price).
  - `price_target` — fires when the daily close is at or above / at or below a set price ("sell at $5"), in
    the holding's own currency.
  - `trailing_stop` — fires when the daily close falls X% below the highest close since the purchase (never
    lower than the purchase price). The high-water mark is stored per trigger and holding in `data.db`, so it
    survives the cache being cleared. Daily closes only, stated in the UI.
- **Revision** — every create/update of a thesis, link, claim or trigger, and every attach/detach of a claim
  or trigger, appends a full snapshot with an optional "why I changed it" note. Nothing is overwritten.
- **Notification** — a to-do item, never passively dismissed. Kinds: trigger fired, claim review due, balance
  update due. Actions: adjust (edit the trigger/claim), record sale, snooze until a date, dismiss with a
  required reason, mark reviewed/updated. A fired trigger does not re-alert for the same link until its
  notification is resolved.
- **Balance snapshot** — a dated value for an account. Self-directed accounts are valued as positions × latest
  price + the latest manually entered cash. Months without an update carry the last value forward, flagged
  stale.

## Sign-in

One login passphrase (≥ 12 characters), changeable in Settings; changing it signs out every other device.
Settings also shows storage: each database's size, table count and total rows, plus any pre-restore copies.

## Base currency and exchange rates

Chosen at install. Other currencies convert with cached daily rates from the Bank of Canada (keyless; turned
on with its own consent checkbox in Settings → Market data). Pairs are derived through CAD. Alpha Vantage is
the fallback for currencies the Bank doesn't publish.

## Reports (v0.2)

- **Balance sheet** — every account's latest value in the base currency, assets minus liabilities, stale and
  unconvertible values flagged. Self-directed accounts = positions × latest price + latest cash; others =
  latest recorded balance. Liability balances are entered as positive amounts owed.
- **Net worth** — a row per month in `net_worth_snapshots`, refreshed on every background run (so a past month
  keeps its last value); the current month is shown live. Line chart plus monthly change bars, with a table.
- **Share of assets by account** and **by thesis** (donuts, max 7 named slices + "Other"). A purchase in
  several open theses is split evenly between them and listed in an addendum; value-tracked assets take their
  account's value divided evenly among the account's value-tracked assets. Unlinked value shows as "Not in any
  thesis".

## Notification delivery

The in-app To do page is the source of truth. New items can also be pushed to **ntfy** (phone notifications,
self-hostable) or a **webhook** (JSON, optional HMAC-SHA256 `X-PFAT-Signature`). Each channel has a detail
level: _minimal_ sends only "you have a new item to review"; _full_ sends the title and text, which may
include tickers, prices and thesis titles. A channel sends nothing until the user ticks a consent box whose
text names the exact destination and detail level; changing either withdraws consent until re-confirmed.
Deliveries go through an outbox and are retried up to 5 times on later background runs. Email via the user's
own SMTP comes later.

## Backups

Manual, from Settings. The user picks data, cache, or both. Always encrypted with a passphrase the user types
(minimum 12 characters): PBKDF2-SHA256 (600,000 iterations) → AES-256-GCM over a gzip-compressed payload of
consistent SQLite copies. The file header (format, contents, schema versions, KDF salt, IV) is readable but
authenticated, so tampering is detected. Restore verifies integrity and schema version, upgrades older
backups, keeps a `pre-restore-<timestamp>/` copy of the replaced files, then swaps the databases in place.
Restoring data signs out every device (sign-ins are never restored) and brings back the login passphrase that
was in use when the backup was made. Device-bound keys are out of scope.

## Milestones

1. **v0.1 (this slice)** — install/login, accounts, instruments, assets, trades with sale allocation, theses,
   links, claims + reviews, reasoning, date and % triggers, revisions, notifications page, scheduler, price
   providers with quota tracking.
2. **v0.2** — balance sheet, snapshots, reports (balance sheet, monthly net-worth change, % of net worth pie
   by account and by thesis), FX conversion.
3. **v0.3** — encrypted backup/restore, webhook + ntfy channels with consent prompts, trailing stops.
4. **Next** — email channel, more trigger types, hosted options (e.g. Deno Deploy / Cloudflare) with explicit
   consent.
