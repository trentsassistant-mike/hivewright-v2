import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import {
  readLatestTaskContextProvenance,
  TASK_CONTEXT_PROVENANCE_KIND,
} from "@/provenance/task-context";

function sqlRows(rows: { chunk: unknown }[]): Sql {
  return vi.fn((strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("chunk::jsonb")) {
      throw new Error("reader should not cast arbitrary diagnostic chunks to jsonb");
    }
    if (!query.includes("chunk LIKE")) {
      throw new Error("reader should filter on the stable provenance marker");
    }
    if (!query.includes("LIMIT 10")) {
      throw new Error("reader should scan a bounded set of candidate provenance rows");
    }
    return Promise.resolve(rows);
  }) as unknown as Sql;
}

describe("task context provenance", () => {
  it("returns the latest provenance entry while tolerating earlier non-JSON diagnostic chunks", async () => {
    const provenanceChunk = JSON.stringify({
      kind: TASK_CONTEXT_PROVENANCE_KIND,
      schemaVersion: 1,
      status: "available",
      entries: [
        {
          sourceClass: "hive_memory",
          reference: "hive_memory:memory-1",
          sourceId: "memory-1",
          sourceTaskId: "task-source-1",
          category: "operations",
          content: "private content should be ignored",
        },
      ],
    });

    const result = await readLatestTaskContextProvenance(sqlRows([
      { chunk: `plain diagnostic output mentioning ${TASK_CONTEXT_PROVENANCE_KIND} but not JSON` },
      { chunk: provenanceChunk },
    ]), "task-1");

    expect(result).toEqual({
      status: "available",
      entries: [
        {
          sourceClass: "hive_memory",
          reference: "hive_memory:memory-1",
          sourceId: "memory-1",
          sourceTaskId: "task-source-1",
          category: "operations",
        },
      ],
      disclaimer: expect.stringContaining("not model-internal reasoning"),
    });
    expect(JSON.stringify(result)).not.toContain("private content");
  });

  it("returns an explicit unavailable state when diagnostic logs contain no provenance chunk", async () => {
    const result = await readLatestTaskContextProvenance(sqlRows([
      { chunk: "plain diagnostic output that is not JSON" },
      { chunk: JSON.stringify({ kind: "other_diagnostic", status: "available" }) },
    ]), "task-1");

    expect(result).toEqual({
      status: "unavailable",
      entries: [],
      disclaimer: expect.stringContaining("not model-internal reasoning"),
    });
  });
});
