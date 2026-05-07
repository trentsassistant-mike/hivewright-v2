import { beforeEach, describe, expect, it } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { calculateRoleQualityScore, SPARSE_QUALITY_SCORE } from "@/quality/score";
import { applicableQualityFloor, loadQualityControlsConfig } from "@/quality/quality-config";

const HIVE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HIVE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES
      (${HIVE_A}, 'quality-a', 'Quality A', 'digital'),
      (${HIVE_B}, 'quality-b', 'Quality B', 'digital')
  `;
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('quality-role', 'Quality Role', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
});

describe("calculateRoleQualityScore", () => {
  it("weights explicit ratings, implicit signals, clean first pass, and doctor penalty", async () => {
    const [task] = await sql<{ id: string }[]>`
      INSERT INTO tasks (
        hive_id, assigned_to, created_by, status, title, brief,
        retry_count, doctor_attempts, completed_at
      )
      VALUES (
        ${HIVE_A}, 'quality-role', 'owner', 'completed', 'Good', 'brief',
        0, 0, NOW()
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO task_quality_signals (
        task_id, hive_id, signal_type, source, evidence, confidence, rating
      )
      VALUES
        (${task.id}, ${HIVE_A}, 'positive', 'explicit_owner_feedback', 'rated 9', 1, 9),
        (${task.id}, ${HIVE_A}, 'negative', 'implicit_ea', 'bad', 0.8, NULL)
    `;

    const score = await calculateRoleQualityScore(sql, HIVE_A, "quality-role");

    expect(score.basis).toBe("composite");
    expect(score.components.explicitRating).toBe(0.9);
    expect(score.components.implicitSignal).toBe(0);
    expect(score.components.qaCleanFirstPass).toBe(1);
    expect(score.components.doctorPenalty).toBe(1);
    expect(score.qualityScore).toBeCloseTo(0.676, 3);
  });

  it("uses completion-rate fallback only when stronger quality data is absent", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, title, brief, completed_at)
      VALUES (${HIVE_A}, 'quality-role', 'owner', 'failed', 'No', 'brief', NOW())
    `;

    const score = await calculateRoleQualityScore(sql, HIVE_A, "quality-role");

    expect(score.basis).toBe("completion_fallback");
    expect(score.qualityScore).toBe(0);
  });

  it("returns a documented sparse default when the role has no task evidence", async () => {
    const score = await calculateRoleQualityScore(sql, HIVE_A, "quality-role");

    expect(score.basis).toBe("sparse_default");
    expect(score.qualityScore).toBe(SPARSE_QUALITY_SCORE);
  });

  it("scopes quality signals by hive and role", async () => {
    const [taskA] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, title, brief, completed_at)
      VALUES (${HIVE_A}, 'quality-role', 'owner', 'completed', 'A', 'brief', NOW())
      RETURNING id
    `;
    const [taskB] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, title, brief, completed_at)
      VALUES (${HIVE_B}, 'quality-role', 'owner', 'completed', 'B', 'brief', NOW())
      RETURNING id
    `;
    await sql`
      INSERT INTO task_quality_signals (task_id, hive_id, signal_type, source, evidence, confidence, rating)
      VALUES
        (${taskA.id}, ${HIVE_A}, 'positive', 'explicit_owner_feedback', 'great', 1, 10),
        (${taskB.id}, ${HIVE_B}, 'negative', 'explicit_owner_feedback', 'bad', 1, 1)
    `;

    const score = await calculateRoleQualityScore(sql, HIVE_A, "quality-role");

    expect(score.components.explicitRating).toBe(1);
  });
});

describe("quality control settings", () => {
  it("loads tested defaults and per-role floor overrides", async () => {
    let config = await loadQualityControlsConfig(sql, HIVE_A);
    expect(config.defaultQualityFloor).toBe(0.7);
    expect(applicableQualityFloor(config, "quality-role")).toBe(0.7);

    await sql`
      INSERT INTO adapter_config (hive_id, adapter_type, config)
      VALUES (
        ${HIVE_A}, 'quality-controls',
        ${sql.json({
          default_quality_floor: 0.75,
          role_quality_floors: { "quality-role": 0.6 },
        })}
      )
    `;

    config = await loadQualityControlsConfig(sql, HIVE_A);
    expect(config.defaultQualityFloor).toBe(0.75);
    expect(applicableQualityFloor(config, "quality-role")).toBe(0.6);
  });
});
