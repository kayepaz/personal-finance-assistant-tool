# Contributing

Thanks for helping. PFAT is run as a BDFL project: the maintainer has final say on scope and design, guided by
[VISION.md](VISION.md).

## Before you start

- For anything bigger than a bug fix, open an issue first so we can agree on the approach.
- Read [docs/SPEC.md](docs/SPEC.md) and [docs/DATA_MODEL.md](docs/DATA_MODEL.md).

## Ground rules

- **No new runtime dependencies** without discussion. Deno's standard runtime and Web APIs come first.
- **Schema changes are migrations.** Add a new numbered file under `server/db/migrations/data/` or `/cache/`;
  never edit a released migration.
- **Money is decimal strings.** Use `server/lib/decimal.ts`; never `number` for money or quantities.
- **Nothing leaves the server without consent.** Any new outbound call must go through the consent check.
- Client code uses erasable TypeScript only (no `enum`, `namespace`, or parameter properties), because the
  server strips types instead of compiling.

## Workflow

1. Fork and branch from `main`.
2. `deno task fmt && deno task lint && deno task check && deno task test` must pass, and so must the browser
   tests in `e2e/` (Playwright; a development-only dependency — the app itself has none).
3. Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:` …).
4. Open a pull request describing what changed and why. Update `CHANGELOG.md` under "Unreleased".
