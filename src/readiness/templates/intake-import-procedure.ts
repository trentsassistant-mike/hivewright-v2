export const INTAKE_IMPORT_STEPS = [
  "Review the completed intake pack for secrets before importing anything.",
  "Store credentials only in encrypted connector credential storage.",
  "Convert durable business facts into hive memory.",
  "Convert hard constraints into policy candidates.",
  "Create initial goals from first 30-day outcomes.",
  "Create connector/setup checklist tasks for missing access.",
  "Create skill/template/procedure candidates only when owner-approved.",
  "Do not create mandatory pipelines from intake alone.",
] as const;

export const INTAKE_IMPORT_PROCEDURE_MARKDOWN = `# HiveWright Business Intake Import Procedure

## Purpose
Convert a completed business intake pack into one controlled-autonomy hive without uncontrolled side effects.

## Preconditions
- Intake pack has been reviewed by the owner.
- Controlled-autonomy scope worksheet is complete.
- No credentials are present in the intake text.
- Runtime data paths are outside the source repository.
- Read-only-first action policy is prepared.

## Procedure
1. **Secret review**
   - Search for passwords, API keys, OAuth tokens, private keys, card numbers, and recovery codes.
   - Stop and move any credential into encrypted connector credential storage.

2. **Memory import**
   - Import stable business facts only: identity, products, customers, preferences, constraints, recurring workflows.
   - Do not import temporary task chatter as memory.

3. **Policy candidates**
   - Convert approval rules, forbidden actions, spend limits, allowed domains, and blocked actions into policy candidates.
   - Mark policy candidates as draft until owner-approved.

4. **Connector setup checklist**
   - Map tool stack to connector status.
   - Start with read-only or dry-run capabilities.
   - Store credentials only through connector credential storage.

5. **Initial goals**
   - Create goals only from the first 30-day outcomes.
   - Each goal needs success criteria, blocked actions, budget cap, and evidence requirements.

6. **Skills/templates/procedures**
   - Create draft skill/template/procedure candidates from repeated workflows.
   - Do not turn captured workflows into mandatory pipelines without owner approval.

7. **Final preflight**
   - Confirm budget profile, kill switch, connector policy, and owner approval rules are active before the first run.
`;

export function renderIntakeImportProcedure(): string {
  return INTAKE_IMPORT_PROCEDURE_MARKDOWN;
}
