# Changelog

All notable changes are documented here. The project follows [Semantic Versioning](https://semver.org/).
Versions are not tagged yet; the headings below group the work by milestone.

## Unreleased

### Added

- Price-target trigger ("sell at $X"), at or above / at or below.
- Crypto (Alpha Vantage digital currency; Finnhub exchange symbols) and precious-metal (spot rate) prices.
- Manual prices per instrument, for assets without a feed or to override a fetched price (migration `0006`).
- Change the login passphrase (signs out other devices).
- Edit trades and instruments; change an account's type with its balance history carried over.
- Settings → Storage: size, tables and rows for each database, and pre-restore copies.
- History entries show what changed: a collapsed table of each field's before and after values (or the initial
  values on create), and thesis history names the claim, trigger or holding involved.

- Real estate accounts hold houses (declared value) and mortgages (amount owed), each with a dated value
  history; the account's value is houses minus mortgages, shown itemized on the balance sheet. Existing real
  estate balances become a house (migration `0007`).

- Delete accounts and assets from their settings. Anything that must go first (assets; or an asset's trades
  and thesis links) is listed in a collapsed panel; balance and value history are deleted with their owner.

- Settings → Communication log: one row per outbound network call (market data, exchange rates, alerts) with a
  collapsible view of the exact URL and the request and response headers and bodies. API keys and tokens are
  masked; the latest 2,000 calls are kept in `cache.db` (cache migration `0002`).

### Changed

- Account types are now self-directed, managed, real estate, and "Simple asset or liability" (formerly cash).
  A simple account is a liability when its balance is negative. Credit card, line of credit / mortgage, other
  asset and other liability accounts become simple accounts, with liability balances made negative (migration
  `0008`).
- Simple accounts are just a balance: they no longer hold assets.
- Sign out moved from Settings to the top-right of the main menu.

### Fixed

- Restoring a backup brought back the sign-ins saved in it, so other devices stayed signed in. A restore now
  signs out every device.

## 0.3.0 — encrypted backups, alerts, trailing stops

### Added

- Encrypted backups (data, cache, or both) and restore from Settings; AES-256-GCM with a mandatory passphrase,
  authenticated header, safety copy before restore.
- Alert channels: ntfy and webhook, each behind its own consent prompt, minimal or full detail, outbox with
  retries, test button.
- Trailing-stop trigger with a persisted high-water mark (migration `0005`).
- README guide for LAN access and HTTPS (Tailscale, Caddy).

### Fixed

- Balances entered from To do were saved with the wrong type on self-directed accounts (migration `0004`).

## 0.2.0 — balance sheet and reports

### Added

- Reports page: balance sheet in the base currency, net worth by month with monthly change, and share of
  assets by account and by thesis (even splits listed in an addendum). Monthly net-worth history (migration
  `0003`).
- Exchange rates from the Bank of Canada (keyless, with its own consent checkbox), Alpha Vantage fallback.
- Claims and triggers are a shared library: attach one to many theses, pick existing ones or "Add new" from a
  thesis, and manage them on the new Claims and Triggers pages (migration `0002`).
- GitHub Actions CI: format, lint, type-check, tests and a start-up smoke test.

## 0.1.0 — first slice

### Added

- Deno server with two SQLite databases (`data.db`, `cache.db`) and a numbered migration runner.
- Passphrase setup, login, and per-device revocable sessions.
- Accounts, instruments, assets, trades with sale allocation to specific purchases.
- Theses with lifecycle and retrospective, thesis links (per purchase or per asset), claims and reviews,
  reasoning entries, append-only revisions.
- Triggers: `sell_on_date`, `sell_after_days`, `pct_change` (avg cost, purchase price, or fixed baseline).
- Notifications to-do page with adjust / sold / snooze / dismiss-with-reason actions.
- Alpha Vantage and Finnhub daily prices with per-day quota tracking, deferral, and consent.
- In-process scheduler.
- PWA client with no build step.

### Fixed

- `.gitignore` hid `server/db/migrations/data/`, so the main schema was never committed.
