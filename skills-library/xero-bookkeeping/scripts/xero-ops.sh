#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# xero-ops.sh — Multi-step Xero workflow wrapper
#
# Wraps xero-api.sh and xero-token.sh with:
#   - Auth retry on 401 (refresh + one retry; exit 1 on second 401)
#   - Rate limiting (60 req/min rolling window; sleep until window clears)
#   - 429 exponential backoff (2^attempt s, max 60s, up to 5 retries)
#
# Workflows:
#   invoice-with-contact-lookup  -- look up contact then create invoice
#   bank-reconciliation          -- match bank vs Xero transactions
#   report-range                 -- fetch and format P&L / BS / trial balance
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------
_TMPDIR=""

_cleanup() {
    [[ -n "$_TMPDIR" ]] && rm -rf "$_TMPDIR"
}
trap _cleanup EXIT

_get_tmpdir() {
    if [[ -z "$_TMPDIR" ]]; then
        _TMPDIR=$(mktemp -d)
    fi
    echo "$_TMPDIR"
}

# ---------------------------------------------------------------------------
# Rate limiting — 60 requests per 60-second rolling window
# ---------------------------------------------------------------------------
declare -a _RATE_TS=()

_rate_prune() {
    local now cutoff new_ts=()
    now=$(date +%s)
    cutoff=$(( now - 60 ))
    for ts in "${_RATE_TS[@]+"${_RATE_TS[@]}"}"; do
        [[ "$ts" -gt "$cutoff" ]] && new_ts+=("$ts")
    done
    _RATE_TS=("${new_ts[@]+"${new_ts[@]}"}")
}

_rate_wait() {
    _rate_prune
    while [[ ${#_RATE_TS[@]} -ge 60 ]]; do
        local oldest now sleep_s
        oldest="${_RATE_TS[0]}"
        now=$(date +%s)
        sleep_s=$(( oldest + 61 - now ))
        if [[ "$sleep_s" -gt 0 ]]; then
            echo "Rate limit reached, waiting ${sleep_s}s..." >&2
            sleep "$sleep_s"
        fi
        _rate_prune
    done
    _RATE_TS+=("$(date +%s)")
}

# ---------------------------------------------------------------------------
# xero_call — rate-limited API call with auth retry and 429 backoff
#
# Sets global _XERO_RESPONSE to the response body.
# Usage: xero_call [xero-api.sh args...]
# ---------------------------------------------------------------------------
_XERO_RESPONSE=""

xero_call() {
    local response attempt backoff

    # Enforce rate limit before every call
    _rate_wait

    response=$(xero-api.sh "$@")

    # Auth retry: on 401 refresh token and retry exactly once
    if echo "$response" | jq -e '.statusCode == 401' > /dev/null 2>&1; then
        echo "Auth expired, refreshing token..." >&2
        xero-token.sh refresh
        _rate_wait
        response=$(xero-api.sh "$@")
        if echo "$response" | jq -e '.statusCode == 401' > /dev/null 2>&1; then
            echo "Error: Authentication failed after token refresh" >&2
            exit 1
        fi
    fi

    # 429 backoff: 2^attempt seconds (2, 4, 8, 16, 32, cap 60), up to 5 retries
    if echo "$response" | jq -e '.statusCode == 429' > /dev/null 2>&1; then
        backoff=2
        for attempt in 1 2 3 4 5; do
            echo "Rate limited (429), backing off ${backoff}s (attempt ${attempt}/5)..." >&2
            sleep "$backoff"
            _rate_wait
            response=$(xero-api.sh "$@")
            if ! echo "$response" | jq -e '.statusCode == 429' > /dev/null 2>&1; then
                break
            fi
            backoff=$(( backoff * 2 ))
            [[ "$backoff" -gt 60 ]] && backoff=60
        done
        if echo "$response" | jq -e '.statusCode == 429' > /dev/null 2>&1; then
            echo "Error: Rate limit exceeded after 5 retries" >&2
            exit 1
        fi
    fi

    _XERO_RESPONSE="$response"
}

# ---------------------------------------------------------------------------
# Workflow: invoice-with-contact-lookup
# ---------------------------------------------------------------------------
cmd_invoice_with_contact_lookup() {
    local contact_name="" amount="" account_code="" due_date="" tax_type="GST"

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --contact-name)  contact_name="$2";  shift 2 ;;
            --amount)        amount="$2";         shift 2 ;;
            --account-code)  account_code="$2";   shift 2 ;;
            --due-date)      due_date="$2";        shift 2 ;;
            --tax-type)      tax_type="$2";        shift 2 ;;
            *) echo "Error: Unknown option: $1" >&2; _usage; exit 1 ;;
        esac
    done

    [[ -z "$contact_name" ]] && { echo "Error: --contact-name is required" >&2; exit 1; }
    [[ -z "$amount" ]]        && { echo "Error: --amount is required" >&2; exit 1; }
    [[ -z "$account_code" ]] && { echo "Error: --account-code is required" >&2; exit 1; }
    [[ -z "$due_date" ]]      && { echo "Error: --due-date is required" >&2; exit 1; }

    # Look up contact by name — do not auto-create if not found
    xero_call get-contacts --name "$contact_name"
    local contact_id
    contact_id=$(echo "$_XERO_RESPONSE" | jq -r '.Contacts[0].ContactID // empty')

    if [[ -z "$contact_id" ]]; then
        echo "Error: Contact not found: ${contact_name}" >&2
        exit 1
    fi

    # Build invoice JSON
    local invoice_json
    invoice_json=$(jq -n \
        --arg   type         "ACCREC"       \
        --arg   contact_id   "$contact_id"  \
        --arg   due_date     "$due_date"    \
        --arg   account_code "$account_code" \
        --argjson amount     "$amount"      \
        --arg   tax_type     "$tax_type"    \
        '{
            Type: $type,
            Contact: { ContactID: $contact_id },
            DueDate: $due_date,
            LineItems: [{
                AccountCode: $account_code,
                Quantity: 1,
                UnitAmount: $amount,
                TaxType: $tax_type
            }]
        }')

    # Create the invoice
    xero_call create-invoice --json "$invoice_json"

    local invoice_id invoice_status
    invoice_id=$(echo "$_XERO_RESPONSE" | jq -r '.Invoices[0].InvoiceID // empty')
    invoice_status=$(echo "$_XERO_RESPONSE" | jq -r '.Invoices[0].Status // empty')

    if [[ -z "$invoice_id" ]]; then
        echo "Error: Invoice creation failed" >&2
        echo "$_XERO_RESPONSE" >&2
        exit 1
    fi

    echo "InvoiceID: ${invoice_id}"
    echo "Status:    ${invoice_status}"
}

# ---------------------------------------------------------------------------
# Workflow: bank-reconciliation
# ---------------------------------------------------------------------------
cmd_bank_reconciliation() {
    local from_date="" to_date="" account_id=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --from-date)  from_date="$2";  shift 2 ;;
            --to-date)    to_date="$2";    shift 2 ;;
            --account-id) account_id="$2"; shift 2 ;;
            *) echo "Error: Unknown option: $1" >&2; _usage; exit 1 ;;
        esac
    done

    [[ -z "$from_date" ]] && { echo "Error: --from-date is required" >&2; exit 1; }
    [[ -z "$to_date" ]]   && { echo "Error: --to-date is required" >&2; exit 1; }

    # Fetch bank statement transactions
    local bank_args=("get-bank-transactions" "--from" "$from_date" "--to" "$to_date")
    [[ -n "$account_id" ]] && bank_args+=("--account-id" "$account_id")
    xero_call "${bank_args[@]}"
    local bank_response="$_XERO_RESPONSE"

    # Fetch Xero transactions for the same period
    xero_call get-transactions --from "$from_date" --to "$to_date"
    local xero_response="$_XERO_RESPONSE"

    # Write responses to temp files for Python matching
    local tmpdir
    tmpdir=$(_get_tmpdir)
    printf '%s' "$bank_response" > "${tmpdir}/bank.json"
    printf '%s' "$xero_response" > "${tmpdir}/xero.json"

    # Match by amount (exact) and date (+/- 1 day tolerance); report results
    python3 - "${tmpdir}/bank.json" "${tmpdir}/xero.json" <<'PYEOF'
import json, sys, datetime


def parse_xero_date(d):
    """Parse /Date(ms+offset)/ or ISO date string to datetime.date."""
    if not d:
        return None
    s = str(d)
    if s.startswith('/Date('):
        # Strip timezone offset suffix before parsing milliseconds
        ms_str = s[6:].split('+')[0].split('-')[0].rstrip(')/')
        return datetime.date.fromtimestamp(int(ms_str) / 1000)
    return datetime.date.fromisoformat(s[:10])


with open(sys.argv[1]) as fh:
    bank_data = json.load(fh)
with open(sys.argv[2]) as fh:
    xero_data = json.load(fh)

bank_txns = bank_data.get('BankTransactions', [])
xero_txns = xero_data.get('BankTransactions', [])

matched = 0
unmatched = []

for btxn in bank_txns:
    bamount = float(btxn.get('Total', 0))
    bdate = parse_xero_date(btxn.get('Date'))
    bdesc = str(btxn.get('Reference', '') or btxn.get('Narration', '') or '')

    found = False
    for xtxn in xero_txns:
        xamount = float(xtxn.get('Total', 0))
        xdate = parse_xero_date(xtxn.get('Date'))
        if abs(bamount - xamount) < 0.005 and bdate and xdate:
            if abs((bdate - xdate).days) <= 1:
                found = True
                break

    if found:
        matched += 1
    else:
        unmatched.append({
            'amount':      bamount,
            'date':        str(bdate) if bdate else 'unknown',
            'description': bdesc[:80],
        })

total = matched + len(unmatched)
print(f'Matched:   {matched}/{total}')
print(f'Unmatched: {len(unmatched)}/{total}')

if unmatched:
    print('\nUnmatched items:')
    print(f"  {'Date':<12}  {'Amount':>12}  Description")
    print(f"  {'-'*12}  {'-'*12}  {'-'*40}")
    for item in unmatched:
        print(f"  {item['date']:<12}  {item['amount']:>12.2f}  {item['description']}")

sys.exit(1 if unmatched else 0)
PYEOF
}

# ---------------------------------------------------------------------------
# Workflow: report-range
# ---------------------------------------------------------------------------
cmd_report_range() {
    local report_type="" from_date="" to_date=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --type)       report_type="$2"; shift 2 ;;
            --from-date)  from_date="$2";   shift 2 ;;
            --to-date)    to_date="$2";     shift 2 ;;
            *) echo "Error: Unknown option: $1" >&2; _usage; exit 1 ;;
        esac
    done

    [[ -z "$report_type" ]] && { echo "Error: --type is required" >&2; exit 1; }
    [[ -z "$from_date" ]]   && { echo "Error: --from-date is required" >&2; exit 1; }
    [[ -z "$to_date" ]]     && { echo "Error: --to-date is required" >&2; exit 1; }

    # Validate from-date < to-date
    local from_epoch to_epoch
    from_epoch=$(date -d "$from_date" +%s 2>/dev/null) \
        || { echo "Error: Invalid --from-date: ${from_date}" >&2; exit 1; }
    to_epoch=$(date -d "$to_date" +%s 2>/dev/null) \
        || { echo "Error: Invalid --to-date: ${to_date}" >&2; exit 1; }
    if [[ "$from_epoch" -ge "$to_epoch" ]]; then
        echo "Error: --from-date must be before --to-date" >&2
        exit 1
    fi

    # Map report type to API command
    local api_cmd
    case "$report_type" in
        pnl)           api_cmd="report-pnl" ;;
        balance-sheet) api_cmd="report-balance-sheet" ;;
        trial-balance) api_cmd="report-trial-balance" ;;
        *)
            echo "Error: Unknown report type '${report_type}'" >&2
            echo "       Valid types: pnl, balance-sheet, trial-balance" >&2
            exit 1
            ;;
    esac

    xero_call "$api_cmd" --from "$from_date" --to "$to_date"
    local report_response="$_XERO_RESPONSE"

    # Write to temp file for Python formatting
    local tmpdir
    tmpdir=$(_get_tmpdir)
    printf '%s' "$report_response" > "${tmpdir}/report.json"

    python3 - "${tmpdir}/report.json" "$report_type" <<'PYEOF'
import json, sys

with open(sys.argv[1]) as fh:
    data = json.load(fh)

report_type = sys.argv[2]
reports = data.get('Reports', [])

if not reports:
    print('No report data returned.')
    sys.exit(0)

report = reports[0]
report_name = report.get('ReportName', report_type)
report_date = report.get('ReportDate', '')

print()
print('=' * 60)
print(f'Report: {report_name}')
if report_date:
    print(f'Period: {report_date}')
print('=' * 60)

COL = 24
total_line = None

for row in report.get('Rows', []):
    row_type = row.get('RowType', '')
    title = row.get('Title', '')

    if row_type == 'Header':
        cells = row.get('Cells', [])
        headers = [c.get('Value', '') for c in cells]
        header_str = '  '.join(f'{h:<{COL}}' for h in headers)
        print()
        print(header_str)
        print('-' * len(header_str))

    elif row_type == 'Section':
        if title:
            print(f'\n{title}')
        for sub in row.get('Rows', []):
            sub_type = sub.get('RowType', '')
            cells = sub.get('Cells', [])
            values = [c.get('Value', '') for c in cells]
            line = '  '.join(f'{v:<{COL}}' for v in values)
            if sub_type == 'SummaryRow':
                print(f'  {"─" * 50}')
                print(f'  {line}')
            else:
                print(f'  {line}')

    elif row_type == 'SummaryRow':
        cells = row.get('Cells', [])
        values = [c.get('Value', '') for c in cells]
        total_line = '  '.join(f'{v:<{COL}}' for v in values)

if total_line:
    print()
    print('=' * 60)
    print(f'TOTALS  {total_line}')
    print('=' * 60)
PYEOF
}

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
_usage() {
    cat >&2 <<'EOF'
Usage: xero-ops.sh <workflow> [options]

Workflows:

  invoice-with-contact-lookup
      --contact-name  NAME        Contact name to look up (required)
      --amount        AMT         Invoice amount, e.g. 500.00 (required)
      --account-code  CODE        Chart-of-accounts code (required)
      --due-date      YYYY-MM-DD  Invoice due date (required)
      --tax-type      TYPE        Tax type, default: GST (optional)

  bank-reconciliation
      --from-date     YYYY-MM-DD  Period start date (required)
      --to-date       YYYY-MM-DD  Period end date (required)
      --account-id    ID          Bank account ID (optional)
      Exits 0 if all transactions matched, 1 if discrepancies found.

  report-range
      --type          TYPE        Report type: pnl, balance-sheet, trial-balance (required)
      --from-date     YYYY-MM-DD  Period start date (required)
      --to-date       YYYY-MM-DD  Period end date (required)

EOF
}

# ---------------------------------------------------------------------------
# Main dispatch
# ---------------------------------------------------------------------------
if [[ $# -lt 1 ]]; then
    _usage
    exit 1
fi

WORKFLOW="$1"; shift

case "$WORKFLOW" in
    invoice-with-contact-lookup) cmd_invoice_with_contact_lookup "$@" ;;
    bank-reconciliation)         cmd_bank_reconciliation         "$@" ;;
    report-range)                cmd_report_range                "$@" ;;
    -h|--help)                   _usage; exit 0 ;;
    *) echo "Error: Unknown workflow: ${WORKFLOW}" >&2; _usage; exit 1 ;;
esac
