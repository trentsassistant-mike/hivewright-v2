import { beforeEach, describe, expect, it } from "vitest";
import { GET, PATCH } from "../../src/app/api/quality/config/route";
import { loadOwnerFeedbackSamplingConfig } from "@/quality/owner-feedback-config";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const HIVE_ID = "aaaaaaaa-5555-4555-8555-aaaaaaaaaaaa";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE_ID}, 'quality-config', 'Quality Config', 'digital')
  `;
});

describe("/api/quality/config", () => {
  it("returns the live effective owner-feedback sampling config for a hive override", async () => {
    await sql`
      INSERT INTO adapter_config (hive_id, adapter_type, config)
      VALUES (
        ${HIVE_ID},
        'owner-feedback-sampling',
        ${sql.json({
          owner_feedback_sample_rate: 0.08,
          ai_peer_feedback_sample_rate: 0.1,
          owner_feedback_per_day_cap: 7,
        })}
      )
    `;

    const res = await GET(new Request(
      `http://localhost/api/quality/config?hiveId=${HIVE_ID}`,
    ));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.source).toBe("hive");
    expect(body.data.effective.owner_feedback_sample_rate).toBe(0.08);
    expect(body.data.effective.ai_peer_feedback_sample_rate).toBe(0.1);
    expect(body.data.effective.owner_feedback_per_day_cap).toBe(7);
    expect(body.data.rawRow.hiveId).toBe(HIVE_ID);
  });

  it("PATCH writes the hive-scoped row and the sampler loader reads it back", async () => {
    const res = await PATCH(new Request("http://localhost/api/quality/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: HIVE_ID,
        owner_feedback_sample_rate: 0.08,
        ai_peer_feedback_sample_rate: 0.15,
      }),
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.source).toBe("hive");
    expect(body.data.effective.ai_peer_feedback_sample_rate).toBe(0.15);

    const rows = await sql`
      SELECT hive_id, adapter_type, config
      FROM adapter_config
      WHERE hive_id = ${HIVE_ID}
        AND adapter_type = 'owner-feedback-sampling'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].config).toMatchObject({
      owner_feedback_sample_rate: 0.08,
      ai_peer_feedback_sample_rate: 0.15,
    });

    const loaded = await loadOwnerFeedbackSamplingConfig(sql, HIVE_ID);
    expect(loaded.sampleRate).toBe(0.08);
    expect(loaded.aiPeerReviewSampleRate).toBe(0.15);
  });
});
