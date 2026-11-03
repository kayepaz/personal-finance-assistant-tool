# Changelog

All notable changes are documented here. The project follows [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Reports page: balance sheet in the base currency, net worth by month with monthly change, and share of
  assets by account and by thesis (even splits listed in an addendum). Monthly net-worth history (migration
  `0003`).
- Exchange rates from the Bank of Canada (keyless, with its own consent checkbox), Alpha Vantage fallback.
- GitHub Actions CI: format, lint, type-check, tests and a start-up smoke test.

- Claims and triggers are a shared library: attach one to many theses, pick existing ones or "Add new" from a
  thesis, and manage them on the new Claims and Triggers pages (migration `0002`).

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
