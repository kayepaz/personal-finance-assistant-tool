-- Monthly net-worth history. The current month's row is refreshed on every background run, so each past
-- month keeps its last value (≈ month end). Lives in data.db because it can't be rebuilt from the cache.

CREATE TABLE net_worth_snapshots (
  month          TEXT PRIMARY KEY,         -- YYYY-MM
  as_of          TEXT NOT NULL,            -- YYYY-MM-DD of the last refresh
  base_currency  TEXT NOT NULL,
  assets         TEXT NOT NULL,            -- decimal, base currency
  liabilities    TEXT NOT NULL,            -- decimal, positive = owed
  net_worth      TEXT NOT NULL,
  detail         TEXT NOT NULL,            -- JSON: per-account values and warnings at that time
  updated_at     INTEGER NOT NULL
) STRICT;
