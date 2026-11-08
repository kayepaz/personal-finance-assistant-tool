-- Tidy the accounts table after the v0.4 account-type changes:
--  * only the four current types are allowed (any stragglers become simple accounts, kind 'cash');
--  * linked_account_id (mortgage -> property links) and auto_update are no longer used and are dropped.
-- Rebuilt in place; the migration runner turns foreign keys off around this file and checks them after.

UPDATE accounts SET kind = 'cash' WHERE kind NOT IN ('self_directed','managed','real_estate','cash');

CREATE TABLE accounts_new (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('self_directed','managed','real_estate','cash')),
  currency           TEXT NOT NULL CHECK (length(currency) = 3),
  tags               TEXT NOT NULL DEFAULT '[]',
  notes              TEXT NOT NULL DEFAULT '',
  update_every_days  INTEGER CHECK (update_every_days IS NULL OR update_every_days > 0),
  archived_at        INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
) STRICT;
INSERT INTO accounts_new
  SELECT id, name, kind, currency, tags, notes, update_every_days, archived_at, created_at, updated_at FROM accounts;
DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;
