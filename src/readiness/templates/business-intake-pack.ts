export const BUSINESS_INTAKE_REQUIRED_SECTIONS = [
  "Business identity",
  "Mission and current priorities",
  "Products and services",
  "Customers and personas",
  "Offers and pricing",
  "Team and roles",
  "Tool stack",
  "Recurring workflows",
  "Approval rules",
  "Forbidden actions",
  "Brand and voice preferences",
  "Evidence and completion standards",
  "First 30-day outcomes",
] as const;

export const BUSINESS_INTAKE_SECRET_WARNING =
  "Do not paste passwords, API keys, OAuth tokens, recovery codes, card numbers, or private keys into this intake pack. Put credentials only into HiveWright connector credential storage.";

export const BUSINESS_INTAKE_PACK_MARKDOWN = `# HiveWright Business Intake Pack

> ${BUSINESS_INTAKE_SECRET_WARNING}

## Business identity
- Legal/trading name:
- Website/domain:
- Primary owner:
- Timezone:
- Locations/markets served:
- Regulatory/compliance notes:

## Mission and current priorities
- What the business exists to do:
- Current top 3 priorities:
- Current biggest bottlenecks:
- What would make the next 30 days successful:

## Products and services
For each offer:
- Name:
- Description:
- Delivery model:
- Fulfilment steps:
- Margin/cost sensitivity:
- Support obligations:

## Customers and personas
- Ideal customers:
- Common objections:
- High-value segments:
- Customers or segments to avoid:
- Sensitive customer data categories:

## Offers and pricing
- Current offers/packages:
- Pricing:
- Discount rules:
- Refund/cancellation rules:
- Commitments HiveWright must never make without approval:

## Team and roles
- Team members:
- Decision owners:
- Escalation contacts:
- Who can approve customer-facing actions:
- Who can approve finance/legal actions:

## Tool stack
For each tool, list purpose and desired controlled-autonomy capability.
- Email/inbox:
- Calendar:
- Documents/storage:
- CRM:
- Finance/accounting:
- Payments:
- Support/helpdesk:
- Website/CMS:
- Social channels:
- Project/task system:
- Analytics/reporting:

## Recurring workflows
For each workflow:
- Name:
- Trigger:
- Inputs/data sources:
- Current steps:
- Expected output:
- Frequency:
- Known failure modes:
- Human approval points:

## Approval rules
- Read-only data HiveWright may access:
- Internal drafts HiveWright may create:
- Internal actions HiveWright may take:
- External actions requiring approval:
- External actions always blocked:
- Emergency escalation channel:

## Forbidden actions
- Never contact these people/segments:
- Never make these claims:
- Never change these systems:
- Never spend money on:
- Never delete/archive:
- Never handle these data types:

## Brand and voice preferences
- Tone:
- Words/phrases to use:
- Words/phrases to avoid:
- Formatting preferences:
- Example good output:
- Example bad output:

## Evidence and completion standards
- What counts as completed work:
- Required evidence for briefs/drafts/actions:
- Acceptable source freshness:
- How uncertainty should be labelled:
- Review cadence:

## First 30-day outcomes
List 1-3 outcomes only.
For each outcome:
- Outcome:
- Why it matters:
- Success criteria:
- Blocked actions:
- Budget cap:
- Stop conditions:
`;

export function renderBusinessIntakePack(): string {
  return BUSINESS_INTAKE_PACK_MARKDOWN;
}
