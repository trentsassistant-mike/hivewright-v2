export const CONTROLLED_SCOPE_REQUIRED_FIELDS = [
  "Controlled domain",
  "Allowed data sources",
  "Blocked data sources",
  "Allowed actions",
  "Blocked actions",
  "Human approval points",
  "Budget cap",
  "Success criteria",
  "Stop conditions",
] as const;

export const CONTROLLED_SCOPE_WORKSHEET_MARKDOWN = `# HiveWright Controlled Scope Worksheet

> Pick one narrow workflow. If the scope sounds like “run the business”, narrow it before increasing autonomy.

## Controlled domain
- Candidate: Daily owner brief / content drafting / finance visibility / lead triage / other:
- One-sentence mission:
- Why this slice matters now:

## Allowed data sources
Only list sources approved for this controlled workflow.
- Source:
- Access mode: read-only / draft-only / approved write:
- Freshness requirement:
- PII/sensitive data notes:

## Blocked data sources
- Source:
- Reason blocked:
- What would be needed to unblock:

## Allowed actions
- Internal summaries:
- Internal draft documents:
- Internal task creation:
- Owner notifications:
- Read-only report pulls:

## Blocked actions
- Customer/vendor messages:
- Public publishing:
- Finance mutations:
- CRM/customer record writes:
- Deletion/archive/destructive changes:
- Subscription/spend changes:

## Human approval points
- Before any external send:
- Before any public content is queued/published:
- Before any customer commitment:
- Before any finance/legal/compliance statement:
- Before expanding data sources or autonomy:

## Budget cap
- Daily AI spend cap:
- Per-goal cap:
- Per-task cap:
- Max retries:
- Max concurrent agents:
- Stop when cap is reached? yes/no:

## Success criteria
- Useful output count required:
- Accuracy threshold:
- Evidence requirements:
- Owner time saved:
- Cost ceiling:

## Stop conditions
- Hallucinated completion claim:
- Privacy/security issue:
- Unapproved external side effect:
- Cost spike:
- Repeated low-quality output:
- Connector instability:
`;

export function renderControlledScopeWorksheet(): string {
  return CONTROLLED_SCOPE_WORKSHEET_MARKDOWN;
}
