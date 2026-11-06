-- Every outbound network call the server makes (market data, exchange rates, alert channels), for the
-- Settings → Communication log. Secrets (API keys, tokens) are masked before storing. Kept in the cache
-- database: useful, but not precious. Trimmed to the most recent entries by the app.
CREATE TABLE network_log (
  id                TEXT PRIMARY KEY,
  started_at        INTEGER NOT NULL,     -- unix ms
  duration_ms       INTEGER NOT NULL,
  purpose           TEXT NOT NULL,        -- e.g. 'Prices · Alpha Vantage'
  method            TEXT NOT NULL,
  url               TEXT NOT NULL,        -- full URL, secrets masked
  request_headers   TEXT NOT NULL,        -- JSON object, secrets masked
  request_body      TEXT NOT NULL DEFAULT '',
  status            INTEGER,              -- NULL when the call failed before a response
  response_headers  TEXT NOT NULL DEFAULT '{}',
  response_body     TEXT NOT NULL DEFAULT '',
  error             TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE INDEX network_log_by_time ON network_log(started_at);
