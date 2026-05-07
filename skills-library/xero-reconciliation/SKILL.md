# Xero Reconciliation

## When to use
When reconciling bank transactions in Xero for a hive.

## Procedure
1. Pull unreconciled transactions from Xero API
2. Match against expected transactions from hive records
3. For each match: confirm the category and reconcile
4. For unmatched transactions: flag for review with suggested categories
5. Generate reconciliation summary with totals

## Notes
- Always check for duplicate transactions before reconciling
- Flag any transaction over $1,000 for manual review
- Respect the hive's chart of accounts
