-- v0.3: outbound notification channels (webhook, ntfy) and trailing-stop triggers.

-- A channel only sends once the user has consented to it (consents.purpose = 'channel:<id>').
CREATE TABLE notification_channels (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('webhook','ntfy')),
  name          TEXT NOT NULL,
  config        TEXT NOT NULL,          -- JSON; per-kind, validated in the app layer (may hold a token/secret)
  detail        TEXT NOT NULL CHECK (detail IN ('minimal','full')),
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  last_sent_at  INTEGER,
  last_error    TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
) STRICT;

-- Outbox: one row per (notification, channel); retried by background runs until sent or given up.
CREATE TABLE notification_deliveries (
  id               TEXT PRIMARY KEY,
  notification_id  TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel_id       TEXT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
  status           TEXT NOT NULL CHECK (status IN ('pending','sent','failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT NOT NULL DEFAULT '',
  created_at       INTEGER NOT NULL,
  sent_at          INTEGER,
  UNIQUE (notification_id, channel_id)
) STRICT;
CREATE INDEX notification_deliveries_pending ON notification_deliveries(status, created_at);

-- Trailing stops remember the highest daily close seen per (trigger, holding) in data.db, so the mark survives
-- the price cache being cleared.
CREATE TABLE trailing_highs (
  trigger_id  TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  link_id     TEXT NOT NULL REFERENCES thesis_links(id) ON DELETE CASCADE,
  high        TEXT NOT NULL,            -- decimal, instrument currency
  high_date   TEXT NOT NULL,            -- YYYY-MM-DD
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (trigger_id, link_id)
) STRICT;

-- Allow the new trigger type (rebuild; the runner turns foreign keys off around this file).
CREATE TABLE triggers_new (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('sell_on_date','sell_after_days','pct_change','trailing_stop')),
  params      TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL CHECK (status IN ('active','retired')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;
INSERT INTO triggers_new SELECT id, type, params, label, status, created_at, updated_at FROM triggers;
DROP TABLE triggers;
ALTER TABLE triggers_new RENAME TO triggers;
