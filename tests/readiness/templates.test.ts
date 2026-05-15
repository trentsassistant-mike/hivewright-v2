import { describe, expect, it } from "vitest";
import { BUSINESS_INTAKE_PACK_MARKDOWN, BUSINESS_INTAKE_REQUIRED_SECTIONS, BUSINESS_INTAKE_SECRET_WARNING } from "@/readiness/templates/business-intake-pack";
import { CONTROLLED_SCOPE_REQUIRED_FIELDS, CONTROLLED_SCOPE_WORKSHEET_MARKDOWN } from "@/readiness/templates/controlled-scope-worksheet";
import { INTAKE_IMPORT_PROCEDURE_MARKDOWN, INTAKE_IMPORT_STEPS } from "@/readiness/templates/intake-import-procedure";

describe("real-business readiness templates", () => {
  it("covers every required business intake section and warns against pasted secrets", () => {
    for (const section of BUSINESS_INTAKE_REQUIRED_SECTIONS) {
      expect(BUSINESS_INTAKE_PACK_MARKDOWN.toLowerCase()).toContain(`## ${section}`.toLowerCase());
    }
    expect(BUSINESS_INTAKE_PACK_MARKDOWN).toContain(BUSINESS_INTAKE_SECRET_WARNING);
    expect(BUSINESS_INTAKE_PACK_MARKDOWN).toContain("connector credential storage");
  });

  it("forces a narrow controlled-autonomy scope with allowed, blocked, approval, budget, success, and stop fields", () => {
    for (const field of CONTROLLED_SCOPE_REQUIRED_FIELDS) {
      expect(CONTROLLED_SCOPE_WORKSHEET_MARKDOWN.toLowerCase()).toContain(`## ${field}`.toLowerCase());
    }
    expect(CONTROLLED_SCOPE_WORKSHEET_MARKDOWN).toContain("If the scope sounds like “run the business”, narrow it before increasing autonomy.");
  });

  it("distinguishes memory, policies, goals, connector setup, and procedure candidates during import", () => {
    const checklist = INTAKE_IMPORT_STEPS.map((step) => `- ${step}`).join("\n");
    expect(`${INTAKE_IMPORT_PROCEDURE_MARKDOWN}\n${checklist}`).toContain("Review the completed intake pack");
    expect(INTAKE_IMPORT_PROCEDURE_MARKDOWN).toContain("Memory import");
    expect(INTAKE_IMPORT_PROCEDURE_MARKDOWN).toContain("Policy candidates");
    expect(INTAKE_IMPORT_PROCEDURE_MARKDOWN).toContain("Initial goals");
    expect(INTAKE_IMPORT_PROCEDURE_MARKDOWN).toContain("Do not turn captured workflows into mandatory pipelines");
  });
});
