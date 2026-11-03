# Changelog

All notable changes are documented here. The project follows [Semantic Versioning](https://semver.org/).

## Unreleased

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
