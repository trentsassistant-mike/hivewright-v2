import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanGeneratedPathPreflight } from "@/security/generated-path-preflight";

const repoRoot = path.resolve(__dirname, "../..");

describe("scanGeneratedPathPreflight", () => {
  it("fails when generated paths include secret-like material, forbidden claims, or missing provenance markers", () => {
    const result = scanGeneratedPathPreflight({
      repoRoot,
      candidatePaths: [
        "tests/fixtures/security-preflight/unsafe-owner-handoff.md",
        "tests/fixtures/security-preflight/unsafe-generated-config.json",
      ],
    });

    expect(result.status).toBe("fail");
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "claim-boundary",
          file: "tests/fixtures/security-preflight/unsafe-owner-handoff.md",
          severity: "high",
        }),
        expect.objectContaining({
          category: "provenance",
          file: "tests/fixtures/security-preflight/unsafe-owner-handoff.md",
          severity: "high",
        }),
        expect.objectContaining({
          category: "secret-material",
          file: "tests/fixtures/security-preflight/unsafe-generated-config.json",
          severity: "high",
        }),
      ]),
    );

    const secretFinding = result.findings.find((finding) => finding.category === "secret-material");
    expect(secretFinding?.detail).not.toContain("realish-secret-value-should-redact-6789");
    expect(result.summary).toMatch(/blocking finding/i);
  });

  it("passes bounded generated artifacts that include verification evidence and provenance markers", () => {
    const result = scanGeneratedPathPreflight({
      repoRoot,
      candidatePaths: ["tests/fixtures/security-preflight/safe-owner-handoff.md"],
    });

    expect(result).toEqual({
      status: "pass",
      summary: "Generated-path preflight scanned 1 file without blocking findings.",
      findings: [],
      scannedFiles: ["tests/fixtures/security-preflight/safe-owner-handoff.md"],
    });
  });

  it("returns an explicit not-enabled status when no generated paths are supplied", () => {
    const result = scanGeneratedPathPreflight({
      repoRoot,
      candidatePaths: [],
    });

    expect(result).toEqual({
      status: "not_enabled",
      summary: "Generated-path preflight not enabled; provide one or more --generated-path arguments.",
      findings: [],
      scannedFiles: [],
    });
  });
});
