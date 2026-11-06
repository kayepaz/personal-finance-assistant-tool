-- Real estate accounts hold two kinds of asset: a property (house) with a declared value, and a mortgage with
-- the balance owed. Each has its own dated value history. A real estate account has no cash or account-level
-- balance: its value is the sum of its properties minus its mortgages.

ALTER TABLE assets ADD COLUMN category TEXT CHECK (category IS NULL OR category IN ('property','mortgage'));

CREATE TABLE asset_values (
  id          TEXT PRIMARY KEY,
  asset_id    TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  as_of       TEXT NOT NULL,              -- YYYY-MM-DD
  amount      TEXT NOT NULL,              -- decimal, account currency; for a mortgage, the amount owed (positive)
  note        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX asset_values_by_asset ON asset_values(asset_id, as_of);

-- Existing real estate accounts: any assets without an instrument become properties.
UPDATE assets SET category = 'property', tracking = 'value'
WHERE instrument_id IS NULL AND account_id IN (SELECT id FROM accounts WHERE kind = 'real_estate');

-- Real estate accounts that recorded a balance on the account itself (and have no property yet) get a property
-- named after the account, and those balances move onto it. The new asset's id reuses the account's id (unique in
-- the assets table, which uses its own ids).
INSERT INTO assets(id, account_id, instrument_id, name, tracking, notes, created_at, updated_at, category)
  SELECT a.id, a.id, NULL, a.name, 'value', '', a.created_at, a.updated_at, 'property'
  FROM accounts a
  WHERE a.kind = 'real_estate'
    AND EXISTS (SELECT 1 FROM account_snapshots s WHERE s.account_id = a.id)
    AND NOT EXISTS (SELECT 1 FROM assets x WHERE x.account_id = a.id AND x.category = 'property');

INSERT INTO asset_values(id, asset_id, as_of, amount, note, created_at)
  SELECT s.id, s.account_id, s.as_of, s.amount, s.note, s.created_at
  FROM account_snapshots s JOIN accounts a ON a.id = s.account_id
  WHERE a.kind = 'real_estate' AND EXISTS (SELECT 1 FROM assets x WHERE x.id = a.id);

DELETE FROM account_snapshots WHERE account_id IN (SELECT id FROM accounts WHERE kind = 'real_estate');
