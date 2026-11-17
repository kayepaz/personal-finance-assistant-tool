-- Market-data providers become a configurable list instead of three fixed entries. Each row is one configured
-- source: a built-in type (Alpha Vantage, Finnhub, Bank of Canada) or a custom JSON API, on a free or paid
-- plan. Free plans are paced (one call every two seconds per provider). Consent stays keyed by provider id
-- ('market_data:<id>'), so providers already set up keep their ids ('alphavantage', 'finnhub', 'bankofcanada')
-- and their consent.

CREATE TABLE providers (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN ('alphavantage','finnhub','bankofcanada','custom')),
  name         TEXT NOT NULL,
  plan         TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','paid')),
  api_key      TEXT,
  daily_limit  INTEGER CHECK (daily_limit IS NULL OR daily_limit > 0),  -- NULL: no daily cap
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  position     INTEGER NOT NULL,                                       -- order providers are tried in
  config       TEXT NOT NULL DEFAULT '{}',                             -- JSON; custom APIs: url, fields, markets
  created_at   INTEGER NOT NULL
) STRICT;

-- Carry over the providers already set up (a key or a consent on record), in the old order.
INSERT INTO providers(id, type, name, plan, api_key, daily_limit, enabled, position, created_at)
SELECT 'alphavantage', 'alphavantage', 'Alpha Vantage', 'free',
       (SELECT value FROM settings WHERE key = 'api_key:alphavantage'), 25, 1, 1, CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE EXISTS (SELECT 1 FROM settings WHERE key = 'api_key:alphavantage')
   OR EXISTS (SELECT 1 FROM consents WHERE purpose = 'market_data:alphavantage' AND revoked_at IS NULL);

INSERT INTO providers(id, type, name, plan, api_key, daily_limit, enabled, position, created_at)
SELECT 'finnhub', 'finnhub', 'Finnhub', 'free',
       (SELECT value FROM settings WHERE key = 'api_key:finnhub'), NULL, 1, 2, CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE EXISTS (SELECT 1 FROM settings WHERE key = 'api_key:finnhub')
   OR EXISTS (SELECT 1 FROM consents WHERE purpose = 'market_data:finnhub' AND revoked_at IS NULL);

INSERT INTO providers(id, type, name, plan, api_key, daily_limit, enabled, position, created_at)
SELECT 'bankofcanada', 'bankofcanada', 'Bank of Canada', 'free', NULL, 200, 1, 3, CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE EXISTS (SELECT 1 FROM consents WHERE purpose = 'market_data:bankofcanada' AND revoked_at IS NULL);

DELETE FROM settings WHERE key IN ('api_key:alphavantage', 'api_key:finnhub');
