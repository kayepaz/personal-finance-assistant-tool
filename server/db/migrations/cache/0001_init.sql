-- PFAT cache.db — rebuildable market data. Safe to delete; it will refill.
-- Rows reference instruments by provider symbol (no cross-database foreign keys).

CREATE TABLE daily_prices (
  provider_symbol  TEXT NOT NULL,
  price_date       TEXT NOT NULL,       -- YYYY-MM-DD (exchange-local trading date)
  close            TEXT NOT NULL,       -- decimal
  currency         TEXT NOT NULL,
  provider         TEXT NOT NULL,
  fetched_at       INTEGER NOT NULL,
  PRIMARY KEY (provider_symbol, price_date)
) STRICT;

CREATE TABLE fx_rates (
  base        TEXT NOT NULL,
  quote       TEXT NOT NULL,
  rate_date   TEXT NOT NULL,
  rate        TEXT NOT NULL,            -- 1 base = rate quote
  provider    TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL,
  PRIMARY KEY (base, quote, rate_date)
) STRICT;

-- Calls made per provider per UTC day, to respect free-tier limits.
CREATE TABLE api_usage (
  provider  TEXT NOT NULL,
  day       TEXT NOT NULL,              -- YYYY-MM-DD (UTC)
  calls     INTEGER NOT NULL DEFAULT 0,
  exhausted INTEGER NOT NULL DEFAULT 0 CHECK (exhausted IN (0,1)),
  PRIMARY KEY (provider, day)
) STRICT;

-- Requests no provider could serve today; retried on a later day.
CREATE TABLE deferred_requests (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('daily_price','fx_rate')),
  key              TEXT NOT NULL UNIQUE, -- provider symbol or BASE/QUOTE
  first_deferred   INTEGER NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT NOT NULL DEFAULT ''
) STRICT;
