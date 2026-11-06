-- v0.2 bug: balances entered from the To do page were saved as 'value' even for self-directed accounts,
-- which are valued from holdings + 'cash', so the entry never showed up. Self-directed accounts only ever
-- record cash, so re-file those entries as cash.
UPDATE account_snapshots SET kind = 'cash'
WHERE kind = 'value' AND account_id IN (SELECT id FROM accounts WHERE kind = 'self_directed');
