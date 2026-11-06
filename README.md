# PFAT — Personal Finance Assistant Tool

Track **why** you bought each self-directed investment and **when** you plan to sell it — plus an approximate
balance sheet of everything you own and owe. Self-hosted. Your data never leaves your server without your
explicit permission.

PFAT is not a ledger: balances are approximate, and taxes, fees and jurisdiction rules are noted, never
calculated.

**Why the local data philosophy? Isn't it easier to use cloud-based services?** See
[Why local data?](VISION.md#why-local-data) in the vision.

## Status

Pre-alpha — v0.2 (theses, triggers, claims, balance sheet and reports). v0.3 (encrypted backups, phone alerts,
trailing stops) is next. See [docs/SPEC.md](docs/SPEC.md) and [docs/DATA_MODEL.md](docs/DATA_MODEL.md).

## Run it

Requires [Deno](https://deno.com) 2.2 or newer. There are no other dependencies and no build step.

```sh
deno task start
```

Open http://localhost:8787 and set your passphrase and base currency. Data is stored in `./data/` (`data.db` =
your data, `cache.db` = market data that can be rebuilt).

| Environment variable     | Default     | Meaning                                                                     |
| ------------------------ | ----------- | --------------------------------------------------------------------------- |
| `PFAT_PORT`              | `8787`      | HTTP port                                                                   |
| `PFAT_HOST`              | `127.0.0.1` | Bind address (use `0.0.0.0` to reach it from other devices on your network) |
| `PFAT_DATA_DIR`          | `./data`    | Where the two SQLite files live                                             |
| `PFAT_SCHEDULER_MINUTES` | `60`        | How often background jobs run                                               |

Market-data keys (Alpha Vantage, Finnhub) are entered in Settings, and each provider is only contacted after
you consent to it.

> Serving PFAT to other devices? Put it behind HTTPS (e.g. Caddy or a Tailscale/WireGuard network). Session
> tokens and your passphrase must not cross a network in plain text.

## Develop

```sh
deno task dev     # restart on change
deno task test    # run the test suite
deno task check   # type-check server and client
deno task lint
deno task fmt
```

## Project

- [VISION.md](VISION.md) — what PFAT is and isn't
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to help
- [SECURITY.md](SECURITY.md) — reporting vulnerabilities
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [CHANGELOG.md](CHANGELOG.md) — semantic versioning

Governance: BDFL ([@kayepaz](https://github.com/kayepaz)). License:
[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`).
