import { beforeEach, describe, expect, it } from "vitest";
import { syncConfiguredHiveModels } from "@/model-health/sync-models";
import { MODEL_ROUTING_ADAPTER_CONFIG_TYPE } from "@/model-routing/policy";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const HIVE_ID = "aaaaaaaa-7777-4777-8777-aaaaaaaaaaaa";
const OPENAI_CREDENTIAL_ID = "bbbbbbbb-7777-4777-8777-bbbbbbbbbbbb";

beforeEach(async () => {
  await truncateAll(sql, { preserveReadOnlyTables: false });
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE_ID}, 'model-sync', 'Model Sync', 'digital')
  `;
  await sql`
    INSERT INTO credentials (id, hive_id, name, key, value, fingerprint)
    VALUES (
      ${OPENAI_CREDENTIAL_ID},
      ${HIVE_ID},
      'OpenAI',
      'OPENAI_API_KEY',
      'encrypted-openai-key',
      '1111111111111111111111111111111111111111111111111111111111111111'
    )
  `;
});

describe("syncConfiguredHiveModels", () => {
  it("upserts active role primary and fallback models without duplicating repeated models", async () => {
    await sql`
      INSERT INTO role_templates (
        slug,
        name,
        department,
        type,
        adapter_type,
        recommended_model,
        fallback_adapter_type,
        fallback_model,
        active
      )
      VALUES
        (
          'dev-agent',
          'Developer',
          'engineering',
          'executor',
          'codex',
          'openai-codex/gpt-5.5',
          'claude-code',
          'anthropic/claude-opus-4-7',
          true
        ),
        (
          'doctor',
          'Doctor',
          'ops',
          'system',
          'codex',
          'openai-codex/gpt-5.5',
          NULL,
          NULL,
          true
        ),
        (
          'legacy',
          'Legacy',
          'ops',
          'executor',
          'claude-code',
          'anthropic/claude-sonnet-4-6',
          NULL,
          NULL,
          false
        ),
        (
          'auto-agent',
          'Auto Agent',
          'ops',
          'executor',
          'auto',
          'auto',
          NULL,
          NULL,
          true
        )
      ON CONFLICT (slug) DO UPDATE
        SET active = EXCLUDED.active,
            adapter_type = EXCLUDED.adapter_type,
            recommended_model = EXCLUDED.recommended_model,
            fallback_adapter_type = EXCLUDED.fallback_adapter_type,
            fallback_model = EXCLUDED.fallback_model
    `;

    const result = await syncConfiguredHiveModels(sql, { hiveId: HIVE_ID });
    const rows = await sql`
      SELECT provider, model_id, adapter_type, credential_id, fallback_priority, enabled
      FROM hive_models
      WHERE hive_id = ${HIVE_ID}
      ORDER BY fallback_priority ASC, provider ASC, model_id ASC
    `;

    expect(result).toMatchObject({
      considered: 3,
      upserted: 2,
      skipped: 1,
    });
    expect(rows).toEqual([
      {
        provider: "openai",
        model_id: "openai-codex/gpt-5.5",
        adapter_type: "codex",
        credential_id: null,
        fallback_priority: 100,
        enabled: true,
      },
      {
        provider: "anthropic",
        model_id: "anthropic/claude-opus-4-7",
        adapter_type: "claude-code",
        credential_id: null,
        fallback_priority: 200,
        enabled: true,
      },
    ]);
  });

  it("canonicalizes provider-prefixed model aliases before deduping configured models", async () => {
    await sql`
      INSERT INTO role_templates (
        slug,
        name,
        department,
        type,
        adapter_type,
        recommended_model,
        active
      )
      VALUES
        (
          'bare-codex',
          'Bare Codex',
          'engineering',
          'executor',
          'codex',
          'gpt-5.5',
          true
        ),
        (
          'prefixed-codex',
          'Prefixed Codex',
          'engineering',
          'executor',
          'codex',
          'openai-codex/gpt-5.5',
          true
        )
      ON CONFLICT (slug) DO UPDATE
        SET active = EXCLUDED.active,
            adapter_type = EXCLUDED.adapter_type,
            recommended_model = EXCLUDED.recommended_model
    `;

    const result = await syncConfiguredHiveModels(sql, { hiveId: HIVE_ID });
    const rows = await sql<{ provider: string; adapter_type: string; model_id: string }[]>`
      SELECT provider, adapter_type, model_id
      FROM hive_models
      WHERE hive_id = ${HIVE_ID}
      ORDER BY model_id ASC
    `;

    expect(result).toMatchObject({
      considered: 1,
      upserted: 1,
      skipped: 0,
    });
    expect(rows).toEqual([
      {
        provider: "openai",
        adapter_type: "codex",
        model_id: "openai-codex/gpt-5.5",
      },
    ]);
  });

  it("does not import auto-routing policy candidates into configured hive models", async () => {
    await sql`
      INSERT INTO adapter_config (hive_id, adapter_type, config)
      VALUES (${HIVE_ID}, 'model-routing', ${sql.json({
        candidates: [
          {
            adapterType: "codex",
            model: "openai-codex/gpt-5.5",
            enabled: true,
            status: "healthy",
          },
        ],
      })})
    `;

    const result = await syncConfiguredHiveModels(sql, { hiveId: HIVE_ID });

    expect(result.sources.routingCandidate).toBe(0);

    const rows = await sql<{ model_id: string }[]>`
      SELECT model_id
      FROM hive_models
      WHERE hive_id = ${HIVE_ID}
        AND model_id = 'openai-codex/gpt-5.5'
    `;
    expect(rows).toHaveLength(0);
  });

  it("does not register unsupported direct image or Gemini live-preview models for health probing", async () => {
    await sql`
      INSERT INTO role_templates (
        slug,
        name,
        department,
        type,
        adapter_type,
        recommended_model,
        active
      )
      VALUES
        (
          'image-agent',
          'Image Agent',
          'media',
          'executor',
          'openai-image',
          'gpt-image-2',
          true
        ),
        (
          'live-agent',
          'Live Agent',
          'ops',
          'executor',
          'gemini',
          'google/gemini-3.1-flash-live-preview',
          true
        ),
        (
          'gemini-agent',
          'Gemini Agent',
          'ops',
          'executor',
          'gemini',
          'google/gemini-3.1-flash-lite-preview',
          true
        )
      ON CONFLICT (slug) DO UPDATE
        SET active = EXCLUDED.active,
            adapter_type = EXCLUDED.adapter_type,
            recommended_model = EXCLUDED.recommended_model
    `;

    await sql`
      INSERT INTO adapter_config (hive_id, adapter_type, config)
      VALUES (
        ${HIVE_ID},
        ${MODEL_ROUTING_ADAPTER_CONFIG_TYPE},
        ${sql.json({
          candidates: [
            {
              adapterType: "openai-image",
              model: "gpt-image-2",
              enabled: true,
            },
            {
              adapterType: "gemini",
              model: "google/gemini-3.1-flash-live-preview",
              enabled: true,
            },
            {
              adapterType: "gemini",
              model: "google/gemini-3.1-flash-lite-preview",
              enabled: true,
            },
          ],
        })}
      )
    `;

    const result = await syncConfiguredHiveModels(sql, { hiveId: HIVE_ID });
    const rows = await sql`
      SELECT provider, model_id, adapter_type, enabled
      FROM hive_models
      WHERE hive_id = ${HIVE_ID}
      ORDER BY model_id ASC
    `;

    expect(result).toMatchObject({
      considered: 3,
      upserted: 1,
      skipped: 2,
    });
    expect(rows).toEqual([
      {
        provider: "google",
        model_id: "google/gemini-3.1-flash-lite-preview",
        adapter_type: "gemini",
        enabled: true,
      },
    ]);
  });
});
