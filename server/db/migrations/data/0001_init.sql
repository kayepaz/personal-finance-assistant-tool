-- PFAT data.db — initial schema.
-- Conventions: ids are UUID v7 TEXT; money/quantities are decimal TEXT; business dates are TEXT YYYY-MM-DD;
-- audit timestamps are INTEGER unix milliseconds (UTC). Foreign keys are enforced (PRAGMA foreign_keys = ON).

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  device_name  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at   INTEGER
) STRICT;

CREATE TABLE accounts (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN
                       ('self_directed','managed','real_estate','cash','credit_card','line_of_credit','other_asset','other_liability')),
  currency           TEXT NOT NULL CHECK (length(currency) = 3),
  tags               TEXT NOT NULL DEFAULT '[]',          -- JSON array of strings, e.g. ["TFSA"]
  notes              TEXT NOT NULL DEFAULT '',            -- jurisdiction / tax notes; never calculated
  update_every_days  INTEGER CHECK (update_every_days IS NULL OR update_every_days > 0),
  auto_update        INTEGER NOT NULL DEFAULT 0 CHECK (auto_update IN (0,1)),
  linked_account_id  TEXT REFERENCES accounts(id) ON DELETE SET NULL, -- e.g. mortgage -> property
  archived_at        INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
) STRICT;

CREATE TABLE account_snapshots (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  as_of       TEXT NOT NULL,                              -- YYYY-MM-DD
  kind        TEXT NOT NULL CHECK (kind IN ('value','cash')),
  amount      TEXT NOT NULL,                              -- decimal, account currency
  source      TEXT NOT NULL CHECK (source IN ('manual','auto')),
  note        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX account_snapshots_by_account ON account_snapshots(account_id, kind, as_of);

CREATE TABLE instruments (
  id               TEXT PRIMARY KEY,
  symbol           TEXT NOT NULL,
  exchange         TEXT NOT NULL DEFAULT '',
  name             TEXT NOT NULL DEFAULT '',
  kind             TEXT NOT NULL CHECK (kind IN ('equity','etf','fund','crypto','metal','other')),
  currency         TEXT NOT NULL CHECK (length(currency) = 3),
  provider_symbol  TEXT NOT NULL,                         -- symbol sent to market-data providers
  created_at       INTEGER NOT NULL,
  UNIQUE (symbol, exchange)
) STRICT;

CREATE TABLE assets (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  instrument_id  TEXT REFERENCES instruments(id) ON DELETE RESTRICT, -- NULL for non-market items (house, art)
  name           TEXT NOT NULL,
  tracking       TEXT NOT NULL CHECK (tracking IN ('trades','value')),
  notes          TEXT NOT NULL DEFAULT '',
  archived_at    INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  CHECK (tracking = 'value' OR instrument_id IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX assets_one_per_instrument_per_account ON assets(account_id, instrument_id) WHERE instrument_id IS NOT NULL;

CREATE TABLE trades (
  id          TEXT PRIMARY KEY,
  asset_id    TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  side        TEXT NOT NULL CHECK (side IN ('buy','sell')),
  trade_date  TEXT NOT NULL,
  quantity    TEXT NOT NULL,                              -- decimal > 0
  price       TEXT NOT NULL,                              -- decimal per unit, asset currency
  fees        TEXT NOT NULL DEFAULT '0',                  -- noted, not used in calculations
  notes       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX trades_by_asset ON trades(asset_id, trade_date);

-- Each sell names the buy(s) it closes (specific identification).
CREATE TABLE sale_allocations (
  sell_trade_id  TEXT NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  buy_trade_id   TEXT NOT NULL REFERENCES trades(id) ON DELETE RESTRICT,
  quantity       TEXT NOT NULL,
  PRIMARY KEY (sell_trade_id, buy_trade_id)
) STRICT;
CREATE INDEX sale_allocations_by_buy ON sale_allocations(buy_trade_id);

CREATE TABLE theses (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  summary        TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL CHECK (status IN ('draft','active','triggered','closed','abandoned')),
  retrospective  TEXT NOT NULL DEFAULT '',
  outcome        TEXT CHECK (outcome IS NULL OR outcome IN ('played_out','partly','wrong','unclear')),
  closed_at      INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
) STRICT;

-- A thesis links to a buy trade (trade-tracked assets) or to a whole asset (value-tracked assets).
CREATE TABLE thesis_links (
  id             TEXT PRIMARY KEY,
  thesis_id      TEXT NOT NULL REFERENCES theses(id) ON DELETE CASCADE,
  asset_id       TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  buy_trade_id   TEXT REFERENCES trades(id) ON DELETE RESTRICT,
  linked_at      INTEGER NOT NULL,
  unlinked_at    INTEGER,
  unlink_reason  TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE UNIQUE INDEX thesis_links_active_unique
  ON thesis_links(thesis_id, asset_id, ifnull(buy_trade_id, '')) WHERE unlinked_at IS NULL;
CREATE INDEX thesis_links_by_asset ON thesis_links(asset_id);

CREATE TABLE claims (
  id                 TEXT PRIMARY KEY,
  thesis_id          TEXT NOT NULL REFERENCES theses(id) ON DELETE CASCADE,
  statement          TEXT NOT NULL,
  review_every_days  INTEGER NOT NULL CHECK (review_every_days > 0),
  next_review_on     TEXT NOT NULL,                       -- YYYY-MM-DD
  status             TEXT NOT NULL CHECK (status IN ('active','retired')),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
) STRICT;

CREATE TABLE claim_reviews (
  id           TEXT PRIMARY KEY,
  claim_id     TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  verdict      TEXT NOT NULL CHECK (verdict IN ('still_true','weakened','no_longer_true')),
  note         TEXT NOT NULL DEFAULT '',
  reviewed_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE reasoning_entries (
  id          TEXT PRIMARY KEY,
  thesis_id   TEXT NOT NULL REFERENCES theses(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE triggers (
  id          TEXT PRIMARY KEY,
  thesis_id   TEXT NOT NULL REFERENCES theses(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('sell_on_date','sell_after_days','pct_change')),
  params      TEXT NOT NULL,                              -- JSON, validated per type in the app layer
  label       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL CHECK (status IN ('active','retired')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

-- One open firing per (trigger, link): no re-alert until the notification is resolved.
CREATE TABLE trigger_firings (
  id               TEXT PRIMARY KEY,
  trigger_id       TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  link_id          TEXT NOT NULL REFERENCES thesis_links(id) ON DELETE CASCADE,
  observed         TEXT NOT NULL,                         -- JSON: price, baseline, date, etc.
  fired_at         INTEGER NOT NULL,
  notification_id  TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  closed_at        INTEGER
) STRICT;
CREATE UNIQUE INDEX trigger_firings_one_open ON trigger_firings(trigger_id, link_id) WHERE closed_at IS NULL;

CREATE TABLE notifications (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('trigger_fired','claim_review_due','balance_update_due')),
  title            TEXT NOT NULL,
  body             TEXT NOT NULL DEFAULT '',
  ref_type         TEXT NOT NULL,                         -- 'trigger' | 'claim' | 'account'
  ref_id           TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('open','snoozed','resolved')),
  snoozed_until    TEXT,                                  -- YYYY-MM-DD
  resolution       TEXT CHECK (resolution IS NULL OR resolution IN ('adjusted','sold','dismissed','reviewed','updated')),
  resolution_note  TEXT NOT NULL DEFAULT '',
  created_at       INTEGER NOT NULL,
  resolved_at      INTEGER
) STRICT;
CREATE INDEX notifications_open ON notifications(status, created_at);
CREATE UNIQUE INDEX notifications_one_open_per_ref
  ON notifications(kind, ref_type, ref_id) WHERE status <> 'resolved' AND kind <> 'trigger_fired';

-- Append-only history of every change to theses, links, claims and triggers.
CREATE TABLE revisions (
  id           TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('thesis','thesis_link','claim','trigger')),
  entity_id    TEXT NOT NULL,
  revision_no  INTEGER NOT NULL,
  action       TEXT NOT NULL CHECK (action IN ('create','update','retire','unlink')),
  data         TEXT NOT NULL,                             -- JSON snapshot after the change
  note         TEXT NOT NULL DEFAULT '',                  -- "why I changed it"
  created_at   INTEGER NOT NULL,
  UNIQUE (entity_type, entity_id, revision_no)
) STRICT;

-- Consent to send data off the server (market-data providers, webhooks, ntfy, email).
CREATE TABLE consents (
  id           TEXT PRIMARY KEY,
  purpose      TEXT NOT NULL,                             -- e.g. 'market_data:alphavantage'
  description  TEXT NOT NULL,                             -- what is sent and where, as shown to the user
  granted_at   INTEGER NOT NULL,
  revoked_at   INTEGER
) STRICT;
CREATE UNIQUE INDEX consents_active ON consents(purpose) WHERE revoked_at IS NULL;

-- API keys and channel settings live in settings (data.db) so they are covered by backups.
