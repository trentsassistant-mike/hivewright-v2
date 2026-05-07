import { beforeEach, describe, expect, it } from "vitest";
import {
  buildEvaluatedReleaseFindingKey,
  normalizeFindingKey,
  recordEvaluatedReleaseFinding,
} from "@/current-tech-research";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let hiveId: string;

beforeEach(async () => {
  await truncateAll(sql);
  const [hive] = await sql<Array<{ id: string }>>`
    INSERT INTO hives (slug, name, type)
    VALUES ('current-tech-registry-test', 'Current Tech Registry Test', 'digital')
    RETURNING id
  `;
  hiveId = hive.id;
});

describe("evaluated release registry", () => {
  it("normalizes finding keys for durable dedupe", () => {
    expect(normalizeFindingKey("  OpenAI: GPT-5.5 Pricing Update!  ")).toBe(
      "openai-gpt-5-5-pricing-update",
    );
  });

  it("builds release keys from vendor, product, version, release date, and source", () => {
    expect(buildEvaluatedReleaseFindingKey({
      vendor: "Vendor",
      product: "SDK",
      version: "1.2.3",
      releaseDate: "2026-04-28",
      sourceUrl: "https://vendor.example/releases/sdk-1?utm=ignored",
    })).toBe("vendor-sdk-1-2-3-2026-04-28-vendor-example-releases-sdk-1");
  });

  it("reuses a terminal no-action repeat within seven days without creating work", async () => {
    const findingKey = buildEvaluatedReleaseFindingKey({
      vendor: "Vendor",
      product: "SDK",
      version: "1.0.0",
      releaseDate: "2026-04-28",
      sourceUrl: "https://vendor.example/releases/sdk-1",
    });
    const first = await recordEvaluatedReleaseFinding(sql, {
      hiveId,
      findingKey,
      sourceUrl: "https://vendor.example/releases/sdk-1",
      sourceDate: "2026-04-28",
      cycleDate: "2026-04-28",
      disposition: "terminal_no_action",
      confidence: 0.92,
      terminalRationale: "No affected HiveWright dependency or product behavior.",
      materialSignature: {
        provider: "vendor",
        affectedLocalVersion: "not-installed",
      },
    });
    const repeat = await recordEvaluatedReleaseFinding(sql, {
      hiveId,
      findingKey,
      sourceUrl: "https://vendor.example/releases/sdk-1",
      sourceDate: "2026-04-28",
      cycleDate: "2026-05-02",
      disposition: "implement",
      confidence: 0.7,
      terminalRationale: "Duplicate scan result.",
      linkedTaskIds: ["11111111-1111-4111-8111-111111111111"],
      linkedDecisionIds: ["22222222-2222-4222-8222-222222222222"],
      materialSignature: {
        provider: "vendor",
        affectedLocalVersion: "not-installed",
      },
    });

    expect(first.action).toBe("created");
    expect(first.suppressDuplicateWork).toBe(false);
    expect(repeat.action).toBe("reused");
    expect(repeat.suppressDuplicateWork).toBe(true);
    expect(repeat.record.id).toBe(first.record.id);
    expect(repeat.record.disposition).toBe("terminal_no_action");
    expect(repeat.record.confidence).toBe(0.92);
    expect(repeat.record.lastSeenCycleDate).toBe("2026-05-02");
    expect(repeat.record.linkedTaskIds).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(repeat.record.linkedDecisionIds).toEqual(["22222222-2222-4222-8222-222222222222"]);

    const [{ records, tasks, decisions }] = await sql<Array<{
      records: number;
      tasks: number;
      decisions: number;
    }>>`
      SELECT
        (SELECT COUNT(*)::int FROM current_tech_evaluated_releases WHERE hive_id = ${hiveId}::uuid) AS records,
        (SELECT COUNT(*)::int FROM tasks WHERE hive_id = ${hiveId}::uuid) AS tasks,
        (SELECT COUNT(*)::int FROM decisions WHERE hive_id = ${hiveId}::uuid) AS decisions
    `;
    expect(records).toBe(1);
    expect(tasks).toBe(0);
    expect(decisions).toBe(0);
  });

  it("reuses a watchlist repeat and preserves the prior trigger", async () => {
    const first = await recordEvaluatedReleaseFinding(sql, {
      hiveId,
      findingKey: "Framework beta release candidate",
      sourceUrl: "https://framework.example/blog/rc",
      sourceDate: "2026-04-29",
      cycleDate: "2026-04-29",
      disposition: "watchlist",
      confidence: 0.81,
      nextTrigger: "Recheck when the stable release notes or pricing page publish.",
      materialSignature: {
        provider: "framework",
      },
    });
    const repeat = await recordEvaluatedReleaseFinding(sql, {
      hiveId,
      findingKey: "Framework Beta Release Candidate",
      sourceUrl: "https://framework.example/blog/rc",
      sourceDate: "2026-04-29",
      cycleDate: "2026-05-01",
      disposition: "owner_decision",
      confidence: 0.75,
      nextTrigger: "Duplicate watchlist mention.",
      materialSignature: {
        provider: "framework",
      },
    });

    expect(first.action).toBe("created");
    expect(repeat.action).toBe("reused");
    expect(repeat.suppressDuplicateWork).toBe(true);
    expect(repeat.record.disposition).toBe("watchlist");
    expect(repeat.record.nextTrigger).toBe(
      "Recheck when the stable release notes or pricing page publish.",
    );
    expect(repeat.materialChangeReasons).toEqual([]);
  });

  it("allows a material-change repeat to proceed without duplicate suppression", async () => {
    await recordEvaluatedReleaseFinding(sql, {
      hiveId,
      findingKey: "Database provider security advisory",
      sourceUrl: "https://database.example/security/advisory",
      sourceDate: "2026-04-30",
      cycleDate: "2026-04-30",
      disposition: "watchlist",
      confidence: 0.77,
      nextTrigger: "Recheck if the advisory starts affecting the deployed provider.",
      materialSignature: {
        provider: "database",
        affectedLocalVersion: "unaffected",
      },
    });
    const repeat = await recordEvaluatedReleaseFinding(sql, {
      hiveId,
      findingKey: "database provider security advisory",
      sourceUrl: "https://database.example/security/advisory",
      sourceDate: "2026-05-01",
      cycleDate: "2026-05-01",
      disposition: "specialist_review",
      confidence: 0.94,
      nextTrigger: "Security review result should decide the remediation scope.",
      linkedDecisionIds: ["33333333-3333-4333-8333-333333333333"],
      materialSignature: {
        provider: "database",
        affectedLocalVersion: "deployed-provider-2026-05-01",
        securityUpdate: "Vendor expanded affected managed runtime list.",
      },
    });

    expect(repeat.action).toBe("material_change");
    expect(repeat.suppressDuplicateWork).toBe(false);
    expect(repeat.materialChangeReasons).toEqual([
      "changed affected local version",
      "new security update",
    ]);
    expect(repeat.record.disposition).toBe("specialist_review");
    expect(repeat.record.confidence).toBe(0.94);
    expect(repeat.record.linkedDecisionIds).toEqual([
      "33333333-3333-4333-8333-333333333333",
    ]);
  });
});
