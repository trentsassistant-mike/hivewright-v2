import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("readiness scripts", () => {
  it("restore smoke refuses destructive restore unless the target DB is explicitly disposable", () => {
    const result = spawnSync(
      "npx",
      ["tsx", "scripts/readiness/restore-smoke.ts", "--dump", "/tmp/nonexistent.dump", "--throwaway-db", "postgres://user:secret@localhost/prod"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Refusing destructive restore smoke");
    expect(result.stderr).not.toContain("secret");
  });

  it("dispatcher health proof only reports sanitized process metadata", () => {
    const result = spawnSync("npx", ["tsx", "scripts/readiness/dispatcher-health-proof.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect([0, 1]).toContain(result.status);
    const parsed = JSON.parse(result.stdout) as { processes?: Array<{ pid: string; kind: string }>; processLines?: string[] };
    expect(parsed).not.toHaveProperty("processLines");
    expect(parsed.processes ?? []).toEqual(
      expect.arrayContaining([]),
    );
    for (const process of parsed.processes ?? []) {
      expect(process).toEqual({ pid: expect.any(String), kind: expect.any(String) });
    }
  });
});
