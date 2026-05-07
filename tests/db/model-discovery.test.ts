import { describe, expect, it } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";

describe("model discovery schema", () => {
  it("stores discovery runs and owner-disabled model locks", async () => {
    await truncateAll(sql);
    const [hive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES ('schema-discovery-hive', 'Schema Discovery Hive', 'digital')
      RETURNING id
    `;

    const [run] = await sql<{ id: string }[]>`
      INSERT INTO model_discovery_runs (
        hive_id,
        adapter_type,
        provider,
        source,
        status,
        models_seen,
        models_imported,
        models_auto_enabled,
        models_marked_stale
      )
      VALUES (${hive.id}, 'gemini', 'google', 'gemini_models_api', 'completed', 2, 2, 1, 0)
      RETURNING id
    `;

    const [catalog] = await sql<{ id: string }[]>`
      INSERT INTO model_catalog (
        provider,
        adapter_type,
        model_id,
        display_name,
        capabilities,
        local,
        discovery_source,
        first_seen_at,
        last_seen_at,
        last_discovery_run_id
      )
      VALUES (
        'google',
        'gemini',
        'google/gemini-2.5-flash',
        'Gemini 2.5 Flash',
        '["text","code"]'::jsonb,
        false,
        'gemini_models_api',
        NOW(),
        NOW(),
        ${run.id}
      )
      RETURNING id
    `;

    const [usage] = await sql<{ owner_disabled_at: Date | null; auto_discovered: boolean }[]>`
      INSERT INTO hive_models (
        hive_id,
        model_catalog_id,
        provider,
        adapter_type,
        model_id,
        enabled,
        auto_discovered,
        owner_disabled_at,
        owner_disabled_reason,
        last_discovery_run_id,
        last_seen_at
      )
      VALUES (
        ${hive.id},
        ${catalog.id},
        'google',
        'gemini',
        'google/gemini-2.5-flash',
        false,
        true,
        NOW(),
        'owner disabled during setup',
        ${run.id},
        NOW()
      )
      RETURNING owner_disabled_at, auto_discovered
    `;

    expect(usage.auto_discovered).toBe(true);
    expect(usage.owner_disabled_at).toBeInstanceOf(Date);
  });
});
