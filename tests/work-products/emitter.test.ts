import { describe, it, expect, beforeEach } from "vitest";
import { emitBinaryWorkProduct, emitWorkProduct, shouldEmitWorkProduct } from "@/work-products/emitter";
import { routeToQa } from "@/dispatcher/qa-router";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let bizId: string;
const hiveWorkspacePath = "/tmp/hivewright-wp-test-hive";

beforeEach(async () => {
  await truncateAll(sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type, workspace_path)
    VALUES ('wp-test-biz', 'WP Test', 'digital', ${hiveWorkspacePath})
    RETURNING *
  `;
  bizId = biz.id;

  await sql`
    INSERT INTO role_templates (slug, name, department, type, adapter_type)
    VALUES ('wp-test-role', 'WP Role', 'wp-emit-test', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
  await sql`
    INSERT INTO role_templates (slug, name, department, type, adapter_type)
    VALUES ('qa', 'QA', 'quality', 'qa', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
});

describe("shouldEmitWorkProduct", () => {
  it("returns true for normal task titles", () => {
    expect(shouldEmitWorkProduct("Build login page")).toBe(true);
  });

  it("returns false for Result: prefix", () => {
    expect(shouldEmitWorkProduct("Result: task routing")).toBe(false);
  });

  it("returns false for ESCALATION: prefix", () => {
    expect(shouldEmitWorkProduct("ESCALATION: API key expired")).toBe(false);
  });

  it("returns false for [Doctor] prefix", () => {
    expect(shouldEmitWorkProduct("[Doctor] Diagnose: failed task")).toBe(false);
  });
});

describe("emitWorkProduct", () => {
  it("writes a work product to the database", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'wp-test-role', 'owner', 'wp-test-emit', 'Do work', 'completed')
      RETURNING *
    `;

    const wp = await emitWorkProduct(sql, {
      taskId: task.id,
      hiveId: bizId,
      roleSlug: "wp-test-role",
      department: "wp-emit-test",
      content: "Here is the full deliverable output from the agent.",
      summary: "Agent completed the work successfully.",
    });

    expect(wp).not.toBeNull();
    expect(wp!.content).toContain("full deliverable");
    expect(wp!.sensitivity).toBe("internal");
  });

  it("classifies sensitivity from content", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'wp-test-role', 'owner', 'wp-test-sensitive', 'Do work', 'completed')
      RETURNING *
    `;

    const wp = await emitWorkProduct(sql, {
      taskId: task.id,
      hiveId: bizId,
      roleSlug: "wp-test-role",
      department: "wp-emit-test",
      content: "Customer email: john@example.com needs follow up",
      summary: "Found customer contact info.",
    });

    expect(wp!.sensitivity).toBe("restricted");
  });

  it("saves frontend-designer output as a design-spec Tailwind/JSX work_product", async () => {
    await sql`
      INSERT INTO role_templates (slug, name, department, type, adapter_type)
      VALUES ('frontend-designer', 'Frontend Designer', 'design', 'executor', 'claude-code')
      ON CONFLICT (slug) DO NOTHING
    `;
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'frontend-designer', 'owner', 'design-spec-output', 'Create design spec', 'completed')
      RETURNING *
    `;

    const wp = await emitWorkProduct(sql, {
      taskId: task.id,
      hiveId: bizId,
      roleSlug: "frontend-designer",
      department: "design",
      content: "## Design Spec\n\nTailwind: `bg-amber-500`\n\n```jsx\n<section />\n```",
      summary: "Design spec with Tailwind and JSX.",
      artifactKind: "design-spec",
      mimeType: "text/markdown",
      metadata: { formats: ["design-spec", "tailwind", "jsx"], source: "frontend-designer" },
    });

    expect(wp!.artifact_kind).toBe("design-spec");
    expect(wp!.mime_type).toBe("text/markdown");
    expect(wp!.content).toContain("Tailwind");
    expect(wp!.content).toContain("jsx");
    expect(wp!.metadata).toMatchObject({
      formats: ["design-spec", "tailwind", "jsx"],
      source: "frontend-designer",
    });
  });

  it("writes binary image work product metadata", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'wp-test-role', 'owner', 'wp-test-image', 'Generate image', 'completed')
      RETURNING *
    `;

    const wp = await emitBinaryWorkProduct(sql, {
      taskId: task.id,
      hiveId: bizId,
      roleSlug: "wp-test-role",
      department: "wp-emit-test",
      content: "Generated image artifact",
      summary: "Generated image artifact",
      artifactKind: "image",
      filePath: `${hiveWorkspacePath}/${task.id}/images/generated.png`,
      mimeType: "image/png",
      width: 1024,
      height: 1024,
      modelName: "gpt-image-2",
      modelSnapshot: "gpt-image-2-2026-04-21",
      promptTokens: 2500,
      outputTokens: 1000,
      costCents: 5,
      metadata: { size: "1024x1024" },
    });

    expect(wp!.artifact_kind).toBe("image");
    expect(wp!.mime_type).toBe("image/png");
    expect(wp!.width).toBe(1024);
    expect(wp!.height).toBe(1024);
    expect(wp!.model_name).toBe("gpt-image-2");
    expect(wp!.model_snapshot).toBe("gpt-image-2-2026-04-21");
    expect(wp!.prompt_tokens).toBe(2500);
    expect(wp!.output_tokens).toBe(1000);
    expect(wp!.cost_cents).toBe(5);
  });

  it("rejects binary image work product paths outside the owning task images directory", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'wp-test-role', 'owner', 'wp-test-image-traversal', 'Generate image', 'completed')
      RETURNING *
    `;

    await expect(emitBinaryWorkProduct(sql, {
      taskId: task.id,
      hiveId: bizId,
      roleSlug: "wp-test-role",
      department: "wp-emit-test",
      content: "Generated image artifact",
      summary: "Generated image artifact",
      artifactKind: "image",
      filePath: `${hiveWorkspacePath}/other-task/images/generated.png`,
      mimeType: "image/png",
      width: 1024,
      height: 1024,
      modelName: "gpt-image-2",
      modelSnapshot: "gpt-image-2-2026-04-21",
    })).rejects.toThrow(/task images/);
  });

  it("persists a long Codex deliverable tail into work_products and the QA brief deliverable section", async () => {
    const tailMarker = "CODEX_LONG_OUTPUT_TAIL_20260429_2e9a5f0c";
    const deliverable = [
      "# Work Product",
      "Codex adapter long-output persistence profile.",
      "A".repeat(25_000),
      "## Verification",
      `Tail marker: ${tailMarker}`,
    ].join("\n");
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, qa_required)
      VALUES (${bizId}, 'wp-test-role', 'owner', 'wp-test-long-codex-output', 'Do work', 'active', true)
      RETURNING *
    `;

    const wp = await emitWorkProduct(sql, {
      taskId: task.id,
      hiveId: bizId,
      roleSlug: "wp-test-role",
      department: "wp-emit-test",
      content: deliverable,
      summary: deliverable,
    });
    const qaTask = await routeToQa(sql, task.id, deliverable);

    expect(wp!.content).toContain(tailMarker);
    expect(wp!.summary).toContain(tailMarker);
    expect(qaTask!.brief).toContain("### Work Product / Completed Deliverable");
    expect(qaTask!.brief).toContain(tailMarker);
  }, 15_000);
});
