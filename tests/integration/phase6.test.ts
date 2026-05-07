import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { syncRoleLibrary } from "@/roles/sync";
import { loadSystemSkills, resolveSkillsForTask } from "@/skills/loader";
import { encrypt, decrypt } from "@/credentials/encryption";
import { storeCredential, loadCredentials } from "@/credentials/manager";
import { promoteInsightToInstruction, loadStandingInstructions } from "@/standing-instructions/manager";
import { proposeSkill, approveSkill, reviewSkill } from "@/skills/self-creation";
// Import OpenClaw adapter
import { OpenClawAdapter } from "@/adapters/openclaw";
import type { SessionContext } from "@/adapters/types";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const TEST_KEY = "test-placeholder-key-replace-32ch";
let bizId: string;

beforeEach(async () => {
  await truncateAll(sql);
  await syncRoleLibrary(path.resolve(__dirname, "../../role-library"), sql);
  const [biz] = await sql`INSERT INTO hives (slug, name, type) VALUES ('p6-integ', 'P6 Integration', 'digital') RETURNING *`;
  bizId = biz.id;
});

describe("Phase 6 Integration", () => {
  it("skills library loads and resolves by slug", () => {
    const skills = loadSystemSkills(path.resolve(__dirname, "../../skills-library"));
    expect(skills.length).toBeGreaterThanOrEqual(2);
    const resolved = resolveSkillsForTask(skills, ["blog-writing"]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toContain("Blog Writing");
  });

  it("credential encryption round-trip works", () => {
    const encrypted = encrypt("my-secret-api-key", TEST_KEY);
    expect(encrypted).not.toBe("my-secret-api-key");
    expect(decrypt(encrypted, TEST_KEY)).toBe("my-secret-api-key");
  });

  it("credential storage and loading with role-based access", async () => {
    await storeCredential(sql, { hiveId: bizId, name: "p6-int-xero-key", key: "XERO_KEY", value: "xero-secret-value", rolesAllowed: ["bookkeeper"], encryptionKey: TEST_KEY });
    const bookCreds = await loadCredentials(sql, { hiveId: bizId, roleSlug: "bookkeeper", requiredKeys: ["XERO_KEY"], encryptionKey: TEST_KEY });
    expect(bookCreds["XERO_KEY"]).toBe("xero-secret-value");
    const devCreds = await loadCredentials(sql, { hiveId: bizId, roleSlug: "dev-agent", requiredKeys: ["XERO_KEY"], encryptionKey: TEST_KEY });
    expect(devCreds["XERO_KEY"]).toBeUndefined();
  });

  it("insight promotion to standing instruction", async () => {
    const [insight] = await sql`INSERT INTO insights (hive_id, content, connection_type, confidence, affected_departments, status) VALUES (${bizId}, 'p6-int-Always validate inputs', 'reinforcing', 0.9, '["engineering","operations"]'::jsonb, 'reviewed') RETURNING *`;
    await promoteInsightToInstruction(sql, insight.id as string);
    const instructions = await loadStandingInstructions(sql, bizId, "engineering");
    expect(instructions.some((i) => i.content.includes("p6-int-Always validate inputs"))).toBe(true);
  });

  it("skill self-creation with QA gate", async () => {
    const draft = await proposeSkill(sql, { hiveId: bizId, roleSlug: "dev-agent", sourceTaskId: undefined, slug: "p6-int-api-testing", content: "# API Testing\n\nHow to test APIs.", scope: "hive" });
    expect(draft.status).toBe("pending");
    await reviewSkill(sql, draft.id, { reviewer: "qa", qaReviewStatus: "approved" });
    await approveSkill(sql, draft.id);
    const [row] = await sql.unsafe(`SELECT status FROM skill_drafts WHERE id = '${draft.id}'`);
    expect(row.status).toBe("approved");
  });

  it("OpenClaw adapter generates context files", () => {
    const adapter = new OpenClawAdapter();
    const ctx: SessionContext = {
      task: { id: "t1", hiveId: bizId, assignedTo: "dev-agent", createdBy: "owner", status: "active", priority: 5, title: "p6-int-test-task", brief: "Do something", parentTaskId: null, goalId: null, sprintNumber: null, qaRequired: false, acceptanceCriteria: null, retryCount: 0, doctorAttempts: 0, failureReason: null, projectId: null },
      roleTemplate: { slug: "dev-agent", department: "engineering", roleMd: "# Dev", soulMd: "Be good", toolsMd: "Use tools" },
      memoryContext: { roleMemory: [], hiveMemory: [], insights: [], capacity: "0/200" },
      skills: [], standingInstructions: ["p6-int-Always test"], goalContext: null, projectWorkspace: null, model: "anthropic/claude-sonnet-4-6", fallbackModel: null, credentials: {},
    };
    // OpenClaw adapter may use generateFiles or similar method
    const translated = adapter.translate(ctx);
    expect(translated).toContain("p6-int-test-task");
    expect(translated).toContain("p6-int-Always test");
    expect(translated).toContain("Be good");
  });
});
