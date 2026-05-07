import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { assertDashboardStartupMigrations } from "@/dashboard/startup";

describe("dashboard startup migration assertion", () => {
  it("uses the shared fail-closed assertion before dashboard traffic is served", async () => {
    const sql = (async (strings: TemplateStringsArray) => {
      const query = strings.join("");
      if (query.includes("to_regclass")) {
        return [{ exists: "drizzle.__drizzle_migrations" }];
      }
      if (query.includes("SELECT hash")) {
        return [];
      }
      throw new Error(`unexpected SQL in fake dashboard startup test: ${query}`);
    }) as unknown as Sql;

    await expect(assertDashboardStartupMigrations(sql)).rejects.toThrow(
      /dashboard[\s\S]*Startup migration assertion failed[\s\S]*0064_quality_feedback_split_lanes/,
    );
  });
});
