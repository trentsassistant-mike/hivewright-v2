import { beforeEach, describe, expect, it } from "vitest";
import { GET, POST } from "../../src/app/api/embedding-config/route";
import { resetEmbeddingConfigCache } from "../../src/memory/embedding-config";
import { testSql as sql, truncateAll } from "../_lib/test-db";

beforeEach(async () => {
  await truncateAll(sql);
  resetEmbeddingConfigCache();
});

describe("GET /api/embedding-config", () => {
  it("returns the catalog and current config", async () => {
    await sql`
      INSERT INTO embedding_config (
        provider,
        model_name,
        dimension,
        api_credential_key,
        endpoint_override,
        status,
        updated_by
      )
      VALUES (
        'openrouter',
        'openai/text-embedding-3-small',
        1536,
        'OPENROUTER_API_KEY',
        'https://openrouter.ai/api/v1',
        'ready',
        'test@local'
      )
    `;

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data.catalog)).toBe(true);
    expect(body.data.catalog.some((entry: { provider: string }) => entry.provider === "openrouter")).toBe(true);
    expect(body.data.config.provider).toBe("openrouter");
    expect(body.data.config.modelName).toBe("openai/text-embedding-3-small");
    expect(body.data.config.dimension).toBe(1536);
    expect(body.data.config.progress).toEqual({
      processed: 0,
      total: 0,
      failed: 0,
      cursor: null,
      errorSummary: null,
    });
    expect(body.data.config.errorSummary).toBeNull();
  });

  it("returns status, cursor, and error summary fields used by the UI", async () => {
    const configId = "00000000-0000-0000-0000-0000000000e1";
    const memoryEmbeddingId = "00000000-0000-0000-0000-0000000000ab";
    await sql`
      INSERT INTO embedding_config (
        id,
        provider,
        model_name,
        dimension,
        api_credential_key,
        endpoint_override,
        status,
        last_reembedded_id,
        reembed_total,
        reembed_processed,
        updated_by
      )
      VALUES (
        ${configId},
        'openrouter',
        'openai/text-embedding-3-small',
        1536,
        'OPENROUTER_API_KEY',
        'https://openrouter.ai/api/v1',
        'reembedding',
        '00000000-0000-0000-0000-0000000000aa',
        12,
        5,
        'test@local'
      )
    `;
    await sql`
      INSERT INTO memory_embeddings (
        id,
        source_type,
        source_id,
        chunk_text
      )
      VALUES (
        ${memoryEmbeddingId},
        'note',
        '00000000-0000-0000-0000-0000000000ac',
        'bad chunk'
      )
    `;
    await sql`
      INSERT INTO embedding_reembed_errors (
        config_id,
        memory_embedding_id,
        source_type,
        source_id,
        chunk_text,
        error_message,
        attempt_count
      )
      VALUES (
        ${configId},
        ${memoryEmbeddingId},
        'note',
        '00000000-0000-0000-0000-0000000000ac',
        'bad chunk',
        'synthetic failure',
        2
      )
    `;

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.config.status).toBe("reembedding");
    expect(body.data.config.progress).toEqual({
      processed: 5,
      total: 12,
      failed: 1,
      cursor: "00000000-0000-0000-0000-0000000000aa",
      errorSummary: {
        count: 1,
        latestMessage: "synthetic failure",
      },
    });
    expect(body.data.errorSummary).toEqual({
      count: 1,
      latestMessage: "synthetic failure",
    });
    expect(body.data.recentErrors).toHaveLength(1);
  });
});

describe("POST /api/embedding-config", () => {
  it("rejects a mismatched dimension", async () => {
    const req = new Request("http://localhost/api/embedding-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        modelName: "text-embedding-3-small",
        dimension: 3072,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/dimension mismatch/i);
  });

  it("persists a valid config and returns it", async () => {
    const req = new Request("http://localhost/api/embedding-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openrouter",
        modelName: "openai/text-embedding-3-small",
        dimension: 1536,
        apiCredentialKey: "OPENROUTER_API_KEY",
        endpointOverride: "https://openrouter.ai/api/v1",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.config.provider).toBe("openrouter");
    expect(body.data.config.apiCredentialKey).toBe("OPENROUTER_API_KEY");
    expect(body.data.config.status).toBe("reembedding");
    expect(body.data.config.progress.processed).toBe(0);
    expect(body.data.config.progress.total).toBe(0);

    const rows = await sql`
      SELECT provider, model_name, dimension, api_credential_key, endpoint_override, status
      FROM embedding_config
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("openrouter");
    expect(rows[0].model_name).toBe("openai/text-embedding-3-small");
    expect(rows[0].dimension).toBe(1536);
    expect(rows[0].status).toBe("reembedding");
  });

  it("treats a matching ready config as an idempotent no-op", async () => {
    await sql`
      INSERT INTO embedding_config (
        provider,
        model_name,
        dimension,
        api_credential_key,
        endpoint_override,
        status,
        reembed_total,
        reembed_processed,
        updated_by
      )
      VALUES (
        'openrouter',
        'openai/text-embedding-3-small',
        1536,
        'OPENROUTER_API_KEY',
        'https://openrouter.ai/api/v1',
        'ready',
        3,
        3,
        'test@local'
      )
    `;

    const req = new Request("http://localhost/api/embedding-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openrouter",
        modelName: "openai/text-embedding-3-small",
        dimension: 1536,
        apiCredentialKey: "OPENROUTER_API_KEY",
        endpointOverride: "https://openrouter.ai/api/v1",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.reembedRequested).toBe(false);
    expect(body.data.config.status).toBe("ready");
    expect(body.data.config.progress.processed).toBe(3);
    expect(body.data.config.progress.total).toBe(3);
  });

  it("restarts a matching ready config when memory embeddings are still missing", async () => {
    await sql`
      INSERT INTO embedding_config (
        provider,
        model_name,
        dimension,
        api_credential_key,
        endpoint_override,
        status,
        reembed_total,
        reembed_processed,
        updated_by
      )
      VALUES (
        'openrouter',
        'openai/text-embedding-3-small',
        1536,
        'OPENROUTER_API_KEY',
        'https://openrouter.ai/api/v1',
        'ready',
        0,
        0,
        'test@local'
      )
    `;
    await sql`
      INSERT INTO memory_embeddings (
        source_type,
        source_id,
        chunk_text
      )
      VALUES (
        'note',
        '00000000-0000-0000-0000-0000000000ad',
        'needs reembed'
      )
    `;

    const req = new Request("http://localhost/api/embedding-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openrouter",
        modelName: "openai/text-embedding-3-small",
        dimension: 1536,
        apiCredentialKey: "OPENROUTER_API_KEY",
        endpointOverride: "https://openrouter.ai/api/v1",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.reembedRequested).toBe(true);
    expect(body.data.config.status).toBe("reembedding");
    expect(body.data.config.progress.processed).toBe(0);
    expect(body.data.config.progress.total).toBe(0);

    const [row] = await sql`
      SELECT status, reembed_total, reembed_processed
      FROM embedding_config
      LIMIT 1
    `;
    expect(row.status).toBe("reembedding");
    expect(row.reembed_total).toBe(0);
    expect(row.reembed_processed).toBe(0);
  });

  it("resets cursor and progress when retrying an unchanged error config", async () => {
    const configId = "00000000-0000-0000-0000-0000000000f1";
    const failedEmbeddingId = "00000000-0000-0000-0000-0000000000f2";
    await sql`
      INSERT INTO embedding_config (
        id,
        provider,
        model_name,
        dimension,
        api_credential_key,
        endpoint_override,
        status,
        last_reembedded_id,
        reembed_total,
        reembed_processed,
        last_error,
        updated_by
      )
      VALUES (
        ${configId},
        'openrouter',
        'openai/text-embedding-3-small',
        1536,
        'OPENROUTER_API_KEY',
        'https://openrouter.ai/api/v1',
        'error',
        '00000000-0000-0000-0000-0000000000ff',
        12,
        9,
        '3 row(s) failed during re-embed. See embedding_reembed_errors.',
        'test@local'
      )
    `;
    await sql`
      INSERT INTO memory_embeddings (
        id,
        source_type,
        source_id,
        chunk_text
      )
      VALUES (
        ${failedEmbeddingId},
        'note',
        '00000000-0000-0000-0000-0000000000fe',
        'retry failed row'
      )
    `;
    await sql`
      INSERT INTO embedding_reembed_errors (
        config_id,
        memory_embedding_id,
        source_type,
        source_id,
        chunk_text,
        error_message,
        attempt_count
      )
      VALUES (
        ${configId},
        ${failedEmbeddingId},
        'note',
        '00000000-0000-0000-0000-0000000000fe',
        'retry failed row',
        'synthetic failure',
        1
      )
    `;

    const req = new Request("http://localhost/api/embedding-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openrouter",
        modelName: "openai/text-embedding-3-small",
        dimension: 1536,
        apiCredentialKey: "OPENROUTER_API_KEY",
        endpointOverride: "https://openrouter.ai/api/v1",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.reembedRequested).toBe(true);
    expect(body.data.config.status).toBe("reembedding");
    expect(body.data.config.lastReembeddedId).toBeNull();
    expect(body.data.config.progress.processed).toBe(0);
    expect(body.data.config.progress.total).toBe(0);

    const [row] = await sql`
      SELECT status, last_reembedded_id, reembed_total, reembed_processed, last_error
      FROM embedding_config
      WHERE id = ${configId}
      LIMIT 1
    `;
    expect(row.status).toBe("reembedding");
    expect(row.last_reembedded_id).toBeNull();
    expect(row.reembed_total).toBe(0);
    expect(row.reembed_processed).toBe(0);
    expect(row.last_error).toBeNull();
  });

  it("does not start a new migration while one is already reembedding", async () => {
    await sql`
      INSERT INTO embedding_config (
        provider,
        model_name,
        dimension,
        api_credential_key,
        endpoint_override,
        status,
        updated_by
      )
      VALUES (
        'ollama',
        'nomic-embed-text',
        768,
        null,
        null,
        'reembedding',
        'test@local'
      )
    `;

    const req = new Request("http://localhost/api/embedding-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        modelName: "text-embedding-3-small",
        dimension: 1536,
        apiCredentialKey: "OPENAI_API_KEY",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already in progress/i);

    const rows = await sql`
      SELECT provider, model_name, dimension, status
      FROM embedding_config
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("ollama");
    expect(rows[0].model_name).toBe("nomic-embed-text");
    expect(rows[0].status).toBe("reembedding");
  });

  it("blocks a duplicate save for the same config while reembedding", async () => {
    await sql`
      INSERT INTO embedding_config (
        provider,
        model_name,
        dimension,
        api_credential_key,
        endpoint_override,
        status,
        updated_by
      )
      VALUES (
        'openrouter',
        'openai/text-embedding-3-small',
        1536,
        'OPENROUTER_API_KEY',
        'https://openrouter.ai/api/v1',
        'reembedding',
        'test@local'
      )
    `;

    const req = new Request("http://localhost/api/embedding-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openrouter",
        modelName: "openai/text-embedding-3-small",
        dimension: 1536,
        apiCredentialKey: "OPENROUTER_API_KEY",
        endpointOverride: "https://openrouter.ai/api/v1",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already in progress/i);

    const rows = await sql`
      SELECT provider, model_name, dimension, status
      FROM embedding_config
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("openrouter");
    expect(rows[0].model_name).toBe("openai/text-embedding-3-small");
    expect(rows[0].status).toBe("reembedding");
  });
});
