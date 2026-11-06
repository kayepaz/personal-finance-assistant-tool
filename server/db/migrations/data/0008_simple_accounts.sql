-- Account types are now: self-directed, managed, real estate, and "simple asset or liability" (kind 'cash').
-- A simple account is an asset when its balance is positive and a liability when negative.
-- Credit card, line of credit / mortgage, other asset and other liability accounts become simple accounts;
-- liability balances, previously entered as positive amounts owed, are negated.
-- (The accounts.kind CHECK still allows the old names; the app no longer creates them.)

UPDATE account_snapshots SET amount = CASE WHEN amount LIKE '-%' THEN substr(amount, 2) ELSE '-' || amount END
WHERE amount NOT IN ('0', '0.0', '0.00')
  AND account_id IN (SELECT id FROM accounts WHERE kind IN ('credit_card','line_of_credit','other_liability'));

UPDATE account_snapshots SET kind = 'value'
WHERE account_id IN (SELECT id FROM accounts WHERE kind IN ('credit_card','line_of_credit','other_asset','other_liability'));

UPDATE accounts SET kind = 'cash', linked_account_id = NULL
WHERE kind IN ('credit_card','line_of_credit','other_asset','other_liability');
