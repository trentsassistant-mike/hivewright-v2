import { describe, it, expect, beforeEach } from "vitest";
import {
  getPendingDraftCount,
  proposeSkill,
  approveSkill,
  rejectSkill,
  publishSkill,
  reviewSkill,
  recordSkillAdoption,
  createOrUpdateSkillCandidateFromSignal,
  loadApprovedSkillCandidates,
} from "@/skills/self-creation";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const PREFIX = "p6-sc-";
let bizId: string;

beforeEach(async () => {
  await truncateAll(sql);

  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('qa', 'QA', 'system', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('p6-sc-test', 'P6 SC Test', 'digital')
    RETURNING *
  `;
  bizId = biz.id;
});

describe("proposeSkill", () => {
  it("creates a draft and a QA task", async () => {
    const draft = await proposeSkill(sql, {
      hiveId: bizId,
      roleSlug: "content-writer",
      slug: PREFIX + "write-listicle",
      content: "# Write Listicle\nAlways use numbered lists with 5-10 items.",
      scope: "role",
    });

    expect(draft.id).toBeTruthy();
    expect(draft.hiveId).toBe(bizId);
    expect(draft.roleSlug).toBe("content-writer");
    expect(draft.targetRoleSlugs).toEqual(["content-writer"]);
    expect(draft.slug).toBe(PREFIX + "write-listicle");
    expect(draft.sourceType).toBe("internal");
    expect(draft.securityReviewStatus).toBe("not_required");
    expect(draft.qaReviewStatus).toBe("pending");
    expect(draft.status).toBe("pending");
    expect(draft.feedback).toBeNull();
    expect(draft.createdAt).toBeInstanceOf(Date);

    // Verify QA task was created
    const tasks = await sql`
      SELECT * FROM tasks WHERE title = ${`[Skill QA] Review: ${PREFIX}write-listicle`}
    `;
    expect(tasks.length).toBe(1);
    expect(tasks[0].assigned_to).toBe("qa");
    expect(tasks[0].hive_id).toBe(bizId);
    expect(tasks[0].status).toBe("pending");
  });

  it("rejects when 5 pending drafts already exist", async () => {
    // Insert 5 pending drafts directly
    for (let i = 1; i <= 5; i++) {
      await sql`
        INSERT INTO skill_drafts (hive_id, role_slug, slug, content, scope, status)
        VALUES (
          ${bizId},
          'content-writer',
          ${PREFIX + `cap-test-${i}`},
          'content',
          'role',
          'pending'
        )
      `;
    }

    const count = await getPendingDraftCount(sql, bizId);
    expect(count).toBe(5);

    await expect(
      proposeSkill(sql, {
        hiveId: bizId,
        roleSlug: "content-writer",
        slug: PREFIX + "cap-overflow",
        content: "This should be blocked.",
        scope: "role",
      }),
    ).rejects.toThrow("pending skill drafts");
  });
});

describe("approveSkill", () => {
  it("marks a QA-reviewed draft as approved", async () => {
    const draft = await proposeSkill(sql, {
      hiveId: bizId,
      roleSlug: "analyst",
      slug: PREFIX + "data-summary",
      content: "# Data Summary\nAlways include a TL;DR at the top.",
      scope: "hive",
    });

    expect(draft.status).toBe("pending");

    await reviewSkill(sql, draft.id, {
      reviewer: "qa",
      qaReviewStatus: "approved",
      feedback: "QA review passed.",
    });

    const approved = await approveSkill(sql, draft.id);
    expect(approved.id).toBe(draft.id);
    expect(approved.status).toBe("approved");
    expect(approved.feedback).toBe("QA review passed.");

    // Verify in DB
    const [row] = await sql`SELECT status FROM skill_drafts WHERE id = ${draft.id}`;
    expect(row.status).toBe("approved");
  });

  it("blocks internal candidate approval until QA review is approved", async () => {
    const draft = await proposeSkill(sql, {
      hiveId: bizId,
      roleSlug: "analyst",
      slug: PREFIX + "internal-qa-required",
      content: "# Internal QA Required\nInternal candidates still need QA.",
      scope: "hive",
    });

    await expect(approveSkill(sql, draft.id, "qa")).rejects.toThrow(
      "approved QA review",
    );

    const [row] = await sql`
      SELECT status, qa_review_status
      FROM skill_drafts
      WHERE id = ${draft.id}
    `;
    expect(row.status).toBe("pending");
    expect(row.qa_review_status).toBe("pending");
  });

  it("blocks QA-signal internal candidate approval until its QA task review is approved", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'qa', 'system', 'Repeated QA failure', 'Needs skill improvement', 'failed')
      RETURNING *
    `;

    const { draft } = await createOrUpdateSkillCandidateFromSignal(sql, {
      hiveId: bizId,
      roleSlug: "dev-agent",
      taskId: task.id as string,
      signalType: "qa_failure",
      rating: 2,
      summary: "QA failed repeatedly before the candidate was reviewed.",
      source: "qa-router",
    });

    expect(draft.sourceType).toBe("internal");
    expect(draft.qaReviewStatus).toBe("pending");

    await expect(approveSkill(sql, draft.id, "api-caller")).rejects.toThrow(
      "approved QA review",
    );

    await reviewSkill(sql, draft.id, {
      reviewer: "qa",
      qaReviewStatus: "approved",
      feedback: "QA review processed.",
    });

    const approved = await approveSkill(sql, draft.id, "qa");
    expect(approved.status).toBe("approved");
    expect(approved.qaReviewStatus).toBe("approved");
  });

  it("blocks approval and publication of external candidates until governance is complete", async () => {
    const draft = await proposeSkill(sql, {
      hiveId: bizId,
      roleSlug: "dev-agent",
      slug: PREFIX + "external-source",
      content: "# External Source\nReview before use.",
      scope: "hive",
      sourceType: "external",
    });

    await expect(approveSkill(sql, draft.id, "qa")).rejects.toThrow(
      "external-source skill candidate",
    );
    await expect(publishSkill(sql, draft.id, "qa")).rejects.toThrow(
      "Cannot publish skill candidate from status 'pending'",
    );

    const reviewed = await reviewSkill(sql, draft.id, {
      reviewer: "security-auditor",
      provenanceUrl: "https://example.com/skill.md",
      licenseNotes: "MIT-compatible example license.",
      securityReviewStatus: "approved",
      qaReviewStatus: "approved",
      feedback: "Reviewed and safe to adapt internally.",
    });
    expect(reviewed.status).toBe("reviewing");
    expect(reviewed.securityReviewStatus).toBe("approved");

    const approved = await approveSkill(sql, draft.id, "qa");
    expect(approved.status).toBe("approved");
    expect(approved.approvedBy).toBe("qa");

    const published = await publishSkill(sql, draft.id, "qa");
    expect(published.status).toBe("published");
    expect(published.publishedAt).toBeInstanceOf(Date);
  });

  it("quarantines external candidates even if a caller tries to pre-approve reviews", async () => {
    const draft = await proposeSkill(sql, {
      hiveId: bizId,
      roleSlug: "dev-agent",
      slug: PREFIX + "external-preapproved",
      content: "# External Preapproved\nShould still be reviewed.",
      scope: "hive",
      sourceType: "external",
      provenanceUrl: "https://example.com/skill.md",
      licenseNotes: "Permissive license claimed by submitter.",
      securityReviewStatus: "approved",
      qaReviewStatus: "approved",
    });

    expect(draft.sourceType).toBe("external");
    expect(draft.status).toBe("pending");
    expect(draft.securityReviewStatus).toBe("pending");
    expect(draft.qaReviewStatus).toBe("pending");

    await expect(approveSkill(sql, draft.id, "qa")).rejects.toThrow(
      "approved security review, and approved QA review",
    );
  });

  it("requires explicit QA approval as well as security approval for external candidates", async () => {
    const draft = await proposeSkill(sql, {
      hiveId: bizId,
      roleSlug: "dev-agent",
      slug: PREFIX + "external-security-only",
      content: "# External Security Only\nSecurity alone is insufficient.",
      scope: "hive",
      sourceType: "external",
      provenanceUrl: "https://example.com/skill.md",
      licenseNotes: "Apache-2.0-compatible example license.",
    });

    await reviewSkill(sql, draft.id, {
      reviewer: "security-auditor",
      securityReviewStatus: "approved",
      feedback: "Security approved, pending QA.",
    });

    await expect(approveSkill(sql, draft.id, "qa")).rejects.toThrow(
      "approved security review, and approved QA review",
    );
  });
});

describe("rejectSkill", () => {
  it("marks a draft as rejected with feedback", async () => {
    const draft = await proposeSkill(sql, {
      hiveId: bizId,
      roleSlug: "marketer",
      slug: PREFIX + "email-blast",
      content: "# Email Blast\nSend emails to all subscribers daily.",
      scope: "role",
    });

    expect(draft.status).toBe("pending");

    const rejected = await rejectSkill(
      sql,
      draft.id,
      "Too aggressive — daily emails will hurt deliverability. Limit to weekly.",
    );

    expect(rejected.id).toBe(draft.id);
    expect(rejected.status).toBe("rejected");
    expect(rejected.feedback).toBe(
      "Too aggressive — daily emails will hurt deliverability. Limit to weekly.",
    );

    // Verify in DB
    const [row] = await sql`SELECT status, feedback FROM skill_drafts WHERE id = ${draft.id}`;
    expect(row.status).toBe("rejected");
    expect(row.feedback).toBe(
      "Too aggressive — daily emails will hurt deliverability. Limit to weekly.",
    );
  });
});

describe("skill candidate feedback integration and discovery", () => {
  it("deduplicates repeated low-quality signals into one candidate", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'qa', 'system', 'Low quality output', 'Needs skill improvement', 'failed')
      RETURNING *
    `;

    const first = await createOrUpdateSkillCandidateFromSignal(sql, {
      hiveId: bizId,
      roleSlug: "dev-agent",
      taskId: task.id as string,
      signalType: "qa_failure",
      rating: 3,
      summary: "QA failed repeatedly for missing repo-path validation.",
      source: "qa-router",
    });
    const second = await createOrUpdateSkillCandidateFromSignal(sql, {
      hiveId: bizId,
      roleSlug: "dev-agent",
      taskId: task.id as string,
      signalType: "qa_failure",
      rating: 2,
      summary: "Second failure should update the existing candidate.",
      source: "qa-router",
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.draft.id).toBe(first.draft.id);
    expect(second.draft.evidence).toHaveLength(2);

    const rows = await sql`
      SELECT COUNT(*)::int AS count
      FROM skill_drafts
      WHERE hive_id = ${bizId}
        AND role_slug = 'dev-agent'
        AND slug = ${first.draft.slug}
    `;
    expect(rows[0].count).toBe(1);
  });

  it("discovers only approved or published candidates for applicable roles", async () => {
    await proposeSkill(sql, {
      hiveId: bizId,
      roleSlug: "dev-agent",
      targetRoleSlugs: ["dev-agent"],
      slug: PREFIX + "draft-hidden",
      content: "# Hidden\nDraft only.",
      scope: "hive",
    });
    const approvedDraft = await proposeSkill(sql, {
      hiveId: bizId,
      roleSlug: "qa",
      targetRoleSlugs: ["dev-agent", "qa"],
      slug: PREFIX + "review-checklist",
      content: "# Review Checklist\nUse a clear verification checklist.",
      scope: "hive",
    });

    await reviewSkill(sql, approvedDraft.id, {
      reviewer: "qa",
      qaReviewStatus: "approved",
      feedback: "QA review passed.",
    });
    await approveSkill(sql, approvedDraft.id, "qa");

    const devCandidates = await loadApprovedSkillCandidates(sql, bizId, "dev-agent");
    const qaCandidates = await loadApprovedSkillCandidates(sql, bizId, "qa");
    const ownerCandidates = await loadApprovedSkillCandidates(sql, bizId, "owner");

    expect(devCandidates.map((candidate) => candidate.slug)).toEqual([
      PREFIX + "review-checklist",
    ]);
    expect(qaCandidates.map((candidate) => candidate.slug)).toEqual([
      PREFIX + "review-checklist",
    ]);
    expect(ownerCandidates).toEqual([]);
  });

  it("records post-adoption metric evidence for later quality comparison", async () => {
    const draft = await proposeSkill(sql, {
      hiveId: bizId,
      roleSlug: "dev-agent",
      slug: PREFIX + "adoption-metrics",
      content: "# Adoption Metrics\nTrack quality deltas after publication.",
      scope: "hive",
    });

    const updated = await recordSkillAdoption(sql, draft.id, {
      roleSlug: "dev-agent",
      summary: "quality_score_delta=0.18; comparison window met five completed tasks.",
      recordedAt: "2026-04-29T00:00:00.000Z",
    });

    expect(updated.adoptionEvidence).toEqual([
      {
        roleSlug: "dev-agent",
        summary: "quality_score_delta=0.18; comparison window met five completed tasks.",
        recordedAt: "2026-04-29T00:00:00.000Z",
      },
    ]);
  });
});
