-- Price-target triggers ("sell at $5"), manual prices, and per-instrument price source.

-- 'auto' = fetched from market-data providers; 'manual' = the user records prices (art, metals, anything
-- without a feed). Manual prices can also be entered for 'auto' instruments; the newest date wins.
ALTER TABLE instruments ADD COLUMN price_source TEXT NOT NULL DEFAULT 'auto' CHECK (price_source IN ('auto','manual'));

-- Manual prices are user data, so they live in data.db (backed up), not the rebuildable cache.
CREATE TABLE manual_prices (
  instrument_id  TEXT NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  price_date     TEXT NOT NULL,          -- YYYY-MM-DD
  close          TEXT NOT NULL,          -- decimal, instrument currency
  note           TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (instrument_id, price_date)
) STRICT;

CREATE TABLE triggers_new (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('sell_on_date','sell_after_days','pct_change','trailing_stop','price_target')),
  params      TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL CHECK (status IN ('active','retired')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;
INSERT INTO triggers_new SELECT id, type, params, label, status, created_at, updated_at FROM triggers;
DROP TABLE triggers;
ALTER TABLE triggers_new RENAME TO triggers;
