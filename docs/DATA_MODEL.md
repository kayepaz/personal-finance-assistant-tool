# PFAT — Data model

The SQL migrations are the source of truth:

- `server/db/migrations/data/` → `data.db` (user data; precious; back it up)
- `server/db/migrations/cache/` → `cache.db` (market data; rebuildable; safe to delete)

## Conventions

| Thing                    | Rule                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| Primary keys             | UUID v7 as TEXT (time-ordered, safe to export/import/merge)                               |
| Money, quantities, rates | Decimal strings as TEXT, computed with `server/lib/decimal.ts` (never floats)             |
| Business dates           | TEXT `YYYY-MM-DD`                                                                         |
| Audit timestamps         | INTEGER unix milliseconds, UTC                                                            |
| Integrity                | `PRAGMA foreign_keys = ON`; `STRICT` tables; business rules in the app layer; no triggers |
| Migrations               | Numbered `.sql` files, applied in order, tracked with `PRAGMA user_version`               |

## Entities (data.db)

```
accounts ──< assets ──< trades ──< sale_allocations >── trades (buys)
   │           │           │
   │           └──< thesis_links >── theses ──< thesis_claims >── claims ──< claim_reviews
   │                       │            ├──< reasoning_entries
   │                       │            └──< thesis_triggers >── triggers ──< trigger_firings >── notifications
   └──< account_snapshots  └── (buy_trade_id: which purchase this thesis covers)
instruments ──< assets
revisions  (append-only snapshots of theses, links, claims, triggers)
consents   (what data may leave the server, and where)
sessions, settings
```

## Key rules (enforced in the app layer)

- An asset is either **trade-tracked** (has an instrument; holdings come from trades) or **value-tracked**
  (managed portfolio, house, art; value comes from snapshots).
- A sell must allocate its full quantity to open buys of the same asset; a buy can't be over-allocated.
- Thesis links on trade-tracked assets point at a buy; links on value-tracked assets point at the asset only.
- Claims and triggers are shared: `thesis_claims` / `thesis_triggers` attach them to theses (detaching keeps
  the row with a reason). A trigger is evaluated for every active link of every thesis it is attached to. A
  firing stays open until its notification is resolved, so the same trigger/link pair never alerts twice in a
  row.
- Every create/update/retire/unlink of a thesis, link, claim or trigger writes a revision row in the same
  transaction.
- `pct_change` baselines: `avg_cost` (open buys of the asset, weighted), `purchase_price` (the linked buy;
  falls back to `avg_cost` for asset-level links), `fixed` (a price stored on the trigger).
