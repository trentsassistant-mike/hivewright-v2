---
name: xero-bookkeeping
description: Xero accounting operations — transactions, invoicing, reconciliation, and financial reporting via xero-api.sh
metadata:
  openclaw:
    requires:
      bins: [jq, python3, bc]
      apis: [xero]
---

# Xero Bookkeeping Skill

Operation reference for Xero accounting via `xero-api.sh`. Auth is delegated to `xero-token.sh` — never call Xero directly.

---

## Role Access

| Operation | bookkeeper | finance-lead | financial-analyst |
|-----------|:----------:|:------------:|:-----------------:|
| get-transactions | READ | READ | READ |
| get-accounts | READ | READ | READ |
| get-contacts | READ | READ | READ |
| report-pnl | READ | READ | READ |
| report-balance-sheet | READ | READ | READ |
| create-invoice | WRITE | — | — |
| create-transaction | WRITE | — | — |
| create-contact | WRITE | — | — |
| reconcile | WRITE | — | — |

finance-lead and financial-analyst: read-only. WRITE operations will be rejected at the role boundary — do not attempt them.

---

## 1. Transaction Recording

**Purpose:** Record income or expense transactions against a chart-of-accounts code.

**Command:**
```bash
xero-api.sh create-transaction \
  --account_code "200" \
  --amount "150.00" \
  --date "2026-03-15" \
  --contact_id "abc-123" \
  --tax_type "GST"
```

**Required Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `account_code` | string | Chart-of-accounts code (e.g. "200" for Sales) |
| `amount` | decimal string | Positive value; direction set by account type |
| `date` | string | ISO 8601 date: YYYY-MM-DD |
| `contact_id` | string | Xero Contact GUID — must exist (use get-contacts to verify) |
| `tax_type` | string | AU tax type code (see table below) |

**AU Tax Types:**

| Code | Rate | Use |
|------|------|-----|
| `GST` | 10% | Standard taxable supply |
| `BAS_EXCLUDED` | 0% | Outside GST scope (e.g. wages, bank charges) |
| `EXEMPTOUTPUT` | 0% | GST-free income (e.g. fresh food, exported goods) |
| `EXEMPTINPUT` | 0% | GST-free expense |

**Example Request (xero-api.sh internal payload):**
```json
{
  "Type": "SPEND",
  "Contact": { "ContactID": "abc-123" },
  "Date": "2026-03-15",
  "LineAmountTypes": "Exclusive",
  "LineItems": [
    {
      "AccountCode": "200",
      "Quantity": 1,
      "UnitAmount": 150.00,
      "TaxType": "GST"
    }
  ]
}
```

**Example Response:**
```json
{
  "BankTransactions": [
    {
      "BankTransactionID": "txn-guid-here",
      "Status": "AUTHORISED",
      "Total": 165.00,
      "TotalTax": 15.00
    }
  ]
}
```

**Error Handling:**

| Code | Meaning | Action |
|------|---------|--------|
| 401 | Token expired | Run `xero-token.sh refresh`, retry once. On second 401: halt and report. |
| 429 | Rate limit hit | Exponential backoff — see Section 7. |
| 400 | Validation error | Log `ValidationErrors` array from response. Fix params. Do not retry blindly. |
| 500 | Xero server error | Retry once after 5s. If repeated: halt, log, escalate. |

**Gotchas:**
- `amount` must be positive — Xero infers debit/credit from account type and transaction `Type` field.
- `date` must be in the past or today. Future-dated transactions may be accepted but flagged for period lock violations.
- Always verify `contact_id` with `get-contacts` before creating a transaction — orphaned contact IDs return a 400.
- GST is calculated on `UnitAmount` exclusive of tax; `Total` in the response will be amount + GST.

---

## 2. Invoice Management

**Purpose:** Create accounts receivable (ACCREC) or accounts payable (ACCPAY) invoices.

**Command:**
```bash
xero-api.sh create-invoice \
  --contact_id "abc-123" \
  --type "ACCREC" \
  --due_date "2026-04-15" \
  --line_items '[{"AccountCode":"200","Quantity":1,"UnitAmount":500.00,"TaxType":"GST"}]'
```

**Required Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `contact_id` | string | Xero Contact GUID |
| `type` | string | `ACCREC` (sales invoice) or `ACCPAY` (bill) |
| `due_date` | string | ISO 8601: YYYY-MM-DD |
| `line_items` | JSON array | One or more line item objects (see below) |

**Line Item Object:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `AccountCode` | string | Yes | Chart-of-accounts code |
| `Quantity` | number | Yes | Units |
| `UnitAmount` | decimal | Yes | Per-unit price excl. tax |
| `TaxType` | string | Yes | AU tax type code |
| `Description` | string | No | Line description |

**Invoice Lifecycle:**

```
DRAFT → SUBMITTED → AUTHORISED → PAID
                 ↓
              VOIDED
```

- Invoices are created as `DRAFT` by default unless `status` param is `AUTHORISED`.
- Only `AUTHORISED` invoices can be paid or used for reconciliation.
- `VOIDED` is terminal — create a new invoice to replace.

**Example Request:**
```json
{
  "Type": "ACCREC",
  "Contact": { "ContactID": "abc-123" },
  "DueDate": "2026-04-15",
  "LineAmountTypes": "Exclusive",
  "LineItems": [
    {
      "Description": "Consulting services March 2026",
      "AccountCode": "200",
      "Quantity": 1,
      "UnitAmount": 500.00,
      "TaxType": "GST"
    }
  ],
  "Status": "DRAFT"
}
```

**Example Response:**
```json
{
  "Invoices": [
    {
      "InvoiceID": "inv-guid-here",
      "InvoiceNumber": "INV-0042",
      "Status": "DRAFT",
      "AmountDue": 550.00,
      "AmountPaid": 0.00,
      "Total": 550.00
    }
  ]
}
```

**Error Handling:**

| Code | Meaning | Action |
|------|---------|--------|
| 401 | Token expired | Refresh and retry once. |
| 429 | Rate limit | Exponential backoff — see Section 7. |
| 400 | Validation error | Inspect `ValidationErrors`. Common: missing `DueDate`, invalid `AccountCode`, zero `Quantity`. |
| 409 | Duplicate invoice | Check `InvoiceNumber` — may already exist. Use `get-transactions` to verify. |
| 500 | Xero error | Retry once after 5s. |

**Gotchas:**
- `ACCREC` = money coming in (sales). `ACCPAY` = money going out (bills). Getting these reversed creates reconciliation chaos.
- `LineAmountTypes: "Exclusive"` means `UnitAmount` is ex-GST. Use `"Inclusive"` only if amounts already include tax.
- Invoice numbers auto-increment if not specified. Specify `InvoiceNumber` for matching to external systems.
- A DRAFT invoice does not appear in aged receivables reports — authorise it when ready to send.

---

## 3. Bank Reconciliation

**Purpose:** Match bank statement transactions to Xero transactions and flag unmatched items.

**This is a multi-step operation.**

### Step 1 — Fetch bank transactions
```bash
xero-api.sh get-bank-transactions \
  --account_id "BANK-ACCOUNT-GUID" \
  --from_date "2026-03-01" \
  --to_date "2026-03-31" \
  > /tmp/bank_txns.json
```

### Step 2 — Fetch Xero transactions for the same period
```bash
xero-api.sh get-transactions \
  --from_date "2026-03-01" \
  --to_date "2026-03-31" \
  > /tmp/xero_txns.json
```

### Step 3 — Match by amount and date
```bash
python3 - <<'EOF'
import json, sys

bank = json.load(open('/tmp/bank_txns.json'))
xero = json.load(open('/tmp/xero_txns.json'))

bank_items = bank.get('BankTransactions', [])
xero_items = xero.get('BankTransactions', [])

matched = []
unmatched_bank = []

for b in bank_items:
    key = (b['Date'][:10], str(b['Total']))
    found = [x for x in xero_items if x['Date'][:10] == key[0] and str(x['Total']) == key[1]]
    if found:
        matched.append({'bank': b['BankTransactionID'], 'xero': found[0]['BankTransactionID']})
    else:
        unmatched_bank.append(b)

print(json.dumps({'matched': matched, 'unmatched': unmatched_bank}, indent=2))
EOF
```

### Step 4 — Reconcile matched items (manual step)

`xero-ops.sh bank-reconciliation` performs matching and discrepancy reporting only. To submit confirmed matches to Xero, call `xero-api.sh reconcile` for each matched pair identified in Step 3:

```bash
xero-api.sh reconcile \
  --transaction_id "xero-txn-guid" \
  --bank_transaction_id "bank-txn-guid"
```

> **Note:** This step is manual — automation only handles the matching phase. Review unmatched items before reconciling.

### Step 5 — Review output

`xero-ops.sh bank-reconciliation` prints a formatted summary directly to stdout, including matched count, unmatched count, and unmatched transaction details. No additional post-processing is required. The command exits 0 if all transactions matched, 1 if discrepancies were found — callers should check the exit code.

**Required Parameters (reconcile):**

| Parameter | Type | Description |
|-----------|------|-------------|
| `transaction_id` | string | Xero BankTransaction GUID |
| `bank_transaction_id` | string | Bank statement transaction ID |

**Error Handling:**

| Code | Meaning | Action |
|------|---------|--------|
| 401 | Token expired | Refresh and retry. |
| 429 | Rate limit | Batch reconcile calls with 1s spacing (Section 7). |
| 400 | Already reconciled | Skip — idempotent; log as warning. |
| 404 | Transaction not found | Log and flag for manual review. |
| 500 | Xero error | Retry once; escalate if persistent. |

**Gotchas:**
- Match on both amount AND date — amount-only matching will create false positives for recurring fixed charges.
- Xero dates include time component (`/Date(1234567890000+1100)/`) — always truncate to `[:10]` for comparison.
- Bank fees and interest often appear in bank feed but have no Xero transaction — flag these as unmatched for bookkeeper review, don't auto-create.
- Reconciliation is irreversible via API — double-check matches before calling reconcile.
- Run reconciliation off-hours if processing more than 100 transactions — reduces 429 risk.

---

## 4. Financial Reporting

**Purpose:** Pull Profit & Loss, Balance Sheet, and Trial Balance reports. Available to all roles (read-only).

**Commands:**

```bash
# Profit & Loss
xero-ops.sh report-range --type pnl \
  --from-date "2026-01-01" \
  --to-date "2026-03-31" \
  > /tmp/pnl.json

# Balance Sheet
xero-ops.sh report-range \
  --type balance-sheet \
  --from-date "2026-03-31" \
  --to-date "2026-03-31" \
  > /tmp/balance_sheet.json

# Trial Balance
xero-ops.sh report-range \
  --type trial-balance \
  --from-date "2026-03-31" \
  --to-date "2026-03-31" \
  > /tmp/trial_balance.json
```

**Parameters:**

| Parameter | Used By | Type | Description |
|-----------|---------|------|-------------|
| `--from-date` | profit-and-loss, balance-sheet, trial-balance | string | Start date for the report range (YYYY-MM-DD format). Required. |
| `--to-date` | profit-and-loss, balance-sheet, trial-balance | string | End date for the report range (YYYY-MM-DD format). Required. |

**Parsing to table with jq:**
```bash
jq -r '
  .Reports[0].Rows[]
  | select(.RowType == "Row")
  | .Cells
  | [.[0].Value, .[1].Value]
  | @tsv
' /tmp/pnl.json | column -t
```

**Parsing to table with python3 (richer formatting):**
```bash
python3 - <<'EOF'
import json

data = json.load(open('/tmp/pnl.json'))
rows = []
for row in data['Reports'][0]['Rows']:
    if row.get('RowType') == 'Row':
        cells = row.get('Cells', [])
        if len(cells) >= 2:
            rows.append((cells[0].get('Value',''), cells[1].get('Value','')))

col1 = max(len(r[0]) for r in rows) if rows else 20
print(f"{'Account':<{col1}}  {'Amount':>12}")
print('-' * (col1 + 14))
for name, amount in rows:
    print(f"{name:<{col1}}  {amount:>12}")
EOF
```

**Example Response (P&L excerpt):**
```json
{
  "Reports": [
    {
      "ReportName": "ProfitAndLoss",
      "ReportDate": "1 January 2026 to 31 March 2026",
      "Rows": [
        {
          "RowType": "Header",
          "Cells": [{"Value": "Account"}, {"Value": "Quarter"}]
        },
        {
          "RowType": "Section",
          "Title": "Income",
          "Rows": [
            {
              "RowType": "Row",
              "Cells": [{"Value": "Sales"}, {"Value": "12500.00"}]
            }
          ]
        }
      ]
    }
  ]
}
```

**Error Handling:**

| Code | Meaning | Action |
|------|---------|--------|
| 401 | Token expired | Refresh and retry. |
| 429 | Rate limit | Reports count toward quota — add 1s delay between report calls. |
| 400 | Invalid date range | `from_date` must be before `to_date`. Check for typos. |
| 404 | No data | Period may have no transactions — return empty table, not an error. |
| 500 | Xero error | Retry once after 5s. |

**Gotchas:**
- Reports are point-in-time — run them after all transactions for the period are entered.
- For Balance Sheet and Trial Balance point-in-time reports, set both `--from-date` and `--to-date` to the end-of-period date (e.g. `2026-03-31`).
- Xero returns amounts as strings, not numbers — use `bc` or python3 `float()` for arithmetic.
- Large organisations may have reports that take 10–15s to generate — do not assume timeout on slow response.
- GST is reported net by default in P&L (exclusive). Confirm with bookkeeper if gross reporting is required.

---

## 5. Contact Management

**Purpose:** Look up and create supplier and customer contacts. Verify before creating to avoid duplicates.

**Commands:**
```bash
# Search contacts
xero-api.sh get-contacts \
  --search "Acme Pty Ltd" \
  > /tmp/contacts.json

# Get contact by ID
xero-api.sh get-contacts \
  --contact_id "abc-123" \
  > /tmp/contact.json

# Create contact
xero-api.sh create-contact \
  --name "Acme Pty Ltd" \
  --email "accounts@acme.com.au" \
  --abn "51824753556" \
  --is_supplier true
```

**Parameters (create-contact):**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Legal entity name |
| `email` | string | No | Primary accounts email |
| `abn` | string | No | Australian Hive Number — 11 digits |
| `acn` | string | No | Australian Company Number — 9 digits |
| `is_supplier` | bool | No | Flag as supplier (ACCPAY) |
| `is_customer` | bool | No | Flag as customer (ACCREC) |
| `phone` | string | No | Primary phone |

**AU ABN Validation:**

ABN must be 11 digits and pass the ATO checksum algorithm. Validate before creating:

```python
def validate_abn(abn: str) -> bool:
    digits = [int(c) for c in abn.replace(' ', '') if c.isdigit()]
    if len(digits) != 11:
        return False
    weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19]
    digits[0] -= 1
    total = sum(d * w for d, w in zip(digits, weights))
    return total % 89 == 0
```

**AU ACN Validation:**

ACN must be 9 digits and pass the ASIC checksum algorithm:

```python
def validate_acn(acn: str) -> bool:
    digits = [int(c) for c in acn.replace(' ', '') if c.isdigit()]
    if len(digits) != 9:
        return False
    weights = [8, 7, 6, 5, 4, 3, 2, 1]
    total = sum(d * w for d, w in zip(digits[:8], weights))
    remainder = (10 - (total % 10)) % 10
    return remainder == digits[8]
```

**Always look up before creating:**
```bash
# Check if contact exists before creating
EXISTING=$(xero-api.sh get-contacts --search "$CONTACT_NAME" | jq '.Contacts | length')
if [ "$EXISTING" -gt 0 ]; then
  echo "Contact exists — use existing ContactID"
  xero-api.sh get-contacts --search "$CONTACT_NAME" | jq '.Contacts[0].ContactID'
else
  xero-api.sh create-contact --name "$CONTACT_NAME" ...
fi
```

**Example Response (create-contact):**
```json
{
  "Contacts": [
    {
      "ContactID": "new-guid-here",
      "Name": "Acme Pty Ltd",
      "IsSupplier": true,
      "IsCustomer": false,
      "ContactStatus": "ACTIVE"
    }
  ]
}
```

**Error Handling:**

| Code | Meaning | Action |
|------|---------|--------|
| 401 | Token expired | Refresh and retry. |
| 429 | Rate limit | Backoff — see Section 7. |
| 400 | Validation error | Check `ValidationErrors`. Common: duplicate name, invalid ABN format. |
| 500 | Xero error | Retry once. |

**Gotchas:**
- Xero allows duplicate contact names — the system won't reject them. Always search first.
- ABN spaces are ignored by Xero but strip them before validation and storage for consistency.
- A contact can be both `IsSupplier` and `IsCustomer` — set both flags if applicable.
- `ContactStatus: "ARCHIVED"` contacts cannot receive new transactions — check status in get-contacts response.
- ABN and ACN are stored as metadata, not validated by Xero — validate them yourself before submitting.

---

## 6. Auth Token Handling

**Purpose:** Manage Xero OAuth2 tokens transparently. Auth is fully delegated to `xero-token.sh`.

**On 401 — refresh and retry once:**
```bash
RESPONSE=$(xero-api.sh "$@")
STATUS=$?

if echo "$RESPONSE" | jq -e '.statusCode == 401' > /dev/null 2>&1; then
  xero-token.sh refresh
  RESPONSE=$(xero-api.sh "$@")
  STATUS=$?
  if echo "$RESPONSE" | jq -e '.statusCode == 401' > /dev/null 2>&1; then
    echo "ERROR: Token refresh failed — second 401 received. Halting." >&2
    exit 1
  fi
fi
```

**Rules — NEVER break these:**

| Rule | Reason |
|------|--------|
| NEVER store tokens in files, logs, or variables that outlive the process | OAuth2 tokens are credentials — treat like passwords |
| NEVER log token values | Tokens in logs = credentials at rest |
| NEVER pass tokens on the command line | Visible in process list (`ps aux`) |
| NEVER retry more than once after refresh | Second 401 = systemic auth failure, not transient |
| NEVER call Xero API directly | Always go through `xero-api.sh` which handles token injection |

**Token lifecycle managed by xero-token.sh:**
- Access tokens expire after 30 minutes.
- Refresh tokens expire after 60 days — if refresh fails with 400, the org connection needs re-authorisation by a human.
- `xero-token.sh refresh` updates the token store atomically — no race conditions from concurrent sessions if `flock` is used.

**Gotchas:**
- A 403 is NOT an auth error — it's a permission error (the token is valid but the connected Xero org lacks the required scope). Do not retry; escalate.
- Token expiry during a long-running reconciliation job is expected — build the refresh-retry pattern into each API call, not just the first.
- If running parallel reconciliation, serialise token refreshes — concurrent refreshes can invalidate each other's refresh tokens.

---

## 7. Rate Limiting

**Purpose:** Stay within Xero's API quota and recover gracefully from 429 responses.

**Xero limits:** 60 requests per minute per organisation (rolling window).

**On 429 — exponential backoff:**
```bash
xero_call_with_backoff() {
  local attempt=0
  local max_attempts=5
  local response

  while [ $attempt -lt $max_attempts ]; do
    response=$(xero-api.sh "$@")
    if echo "$response" | jq -e '.statusCode == 429' > /dev/null 2>&1; then
      attempt=$((attempt + 1))
      if [ $attempt -ge $max_attempts ]; then
        echo "ERROR: Rate limit exceeded after $max_attempts attempts. Halting." >&2
        exit 1
      fi
      # 2^attempt seconds: 2, 4, 8, 16, 32 — capped at 60
      delay=$(python3 -c "print(min(2**$attempt, 60))")
      echo "Rate limited — waiting ${delay}s (attempt $attempt/$max_attempts)" >&2
      sleep "$delay"
    else
      echo "$response"
      return 0
    fi
  done
}
```

**Backoff schedule:**

| Attempt | Delay |
|---------|-------|
| 1 | 2s |
| 2 | 4s |
| 3 | 8s |
| 4 | 16s |
| 5 | 32s |
| (cap) | 60s max |

**Bulk operation spacing:**

When processing multiple items (reconciliation, bulk invoice creation), space calls at 1s minimum:

```bash
for item in "${items[@]}"; do
  xero_call_with_backoff create-transaction --contact_id "$item" ...
  sleep 1
done
```

**Budget your requests:**
- Each `get-*` call = 1 request
- Each `create-*` call = 1 request
- Reports (`report-pnl`, `report-balance-sheet`) = 1 request each
- Reconciliation with 100 items = 100+ requests — plan for 2+ minutes

**Gotchas:**
- 429 includes a `Retry-After` header — `xero-api.sh` may expose this; use it if available instead of fixed backoff.
- Concurrent sessions sharing the same Xero org share the same 60 req/min quota — coordinate if running parallel jobs.
- Report requests are expensive — cache report output to file rather than re-fetching within the same session.
- The quota window is rolling, not fixed-minute — 60 requests in any 60-second window.
- Hitting the limit repeatedly within a session suggests a logic bug (loop without break, unnecessary re-fetches) — investigate before assuming the limit is too low.
