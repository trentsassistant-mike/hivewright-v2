import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../_lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("../../../_lib/auth", () => ({
  requireApiUser: vi.fn(),
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: vi.fn(),
}));

vi.mock("@/security/preflight-report", () => ({
  readTaskSecurityPreflight: vi.fn(),
}));

import { GET } from "./route";
import { sql } from "../../../_lib/db";
import { requireApiUser } from "../../../_lib/auth";
import { canAccessHive } from "@/auth/users";
import { readTaskSecurityPreflight } from "@/security/preflight-report";
import { summarizeNpmAuditReport } from "@/security/npm-audit-summary";

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const mockRequireApiUser = requireApiUser as unknown as ReturnType<typeof vi.fn>;
const mockCanAccessHive = canAccessHive as unknown as ReturnType<typeof vi.fn>;
const mockReadTaskSecurityPreflight = readTaskSecurityPreflight as unknown as ReturnType<typeof vi.fn>;

const params = { params: Promise.resolve({ id: "task-1" }) };

describe("GET /api/tasks/[id]/security-preflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mockReadTaskSecurityPreflight.mockReturnValue({
      reportPath: "/runtime/reports/security/baseline-security-scan.json",
      generatedAt: "2026-05-13T00:00:00.000Z",
      secretScan: {
        status: "unsupported",
        summary: "gitleaks is not installed",
        findings: [],
      },
      dependencyScan: {
        status: "fail",
        summary: "npm audit summary: 0 critical, 1 high, 7 moderate, 0 low. Blocking npm audit advisories: fast-uri: fast-uri vulnerable to path traversal via percent-encoded dot segments (GHSA-q3j6-qgpj-74h6); fast-uri vulnerable to host confusion via percent-encoded authority delimiters (GHSA-v39h-62p7-jpjc).",
        findings: [
          {
            severity: "high",
            title: "npm audit found high or critical vulnerabilities",
            detail: "npm audit summary: 0 critical, 1 high, 7 moderate, 0 low. Blocking npm audit advisories: fast-uri: fast-uri vulnerable to path traversal via percent-encoded dot segments (GHSA-q3j6-qgpj-74h6); fast-uri vulnerable to host confusion via percent-encoded authority delimiters (GHSA-v39h-62p7-jpjc).",
          },
        ],
      },
    });
  });

  it("rejects callers without access to the owning hive", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      user: { id: "member-1", email: "member@example.com", isSystemOwner: false },
    });
    mockSql.mockResolvedValueOnce([{ id: "task-1", hive_id: "hive-1" }]);
    mockCanAccessHive.mockResolvedValueOnce(false);

    const res = await GET(new Request("http://localhost/api/tasks/task-1/security-preflight"), params);

    expect(res.status).toBe(403);
    expect(mockCanAccessHive).toHaveBeenCalledWith(mockSql, "member-1", "hive-1");
    expect(mockReadTaskSecurityPreflight).not.toHaveBeenCalled();
  });

  it("returns discrete secretScan and dependencyScan outcomes for accessible tasks", async () => {
    mockSql.mockResolvedValueOnce([{ id: "task-1", hive_id: "hive-1" }]);

    const res = await GET(new Request("http://localhost/api/tasks/task-1/security-preflight"), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      taskId: "task-1",
      reportPath: "/runtime/reports/security/baseline-security-scan.json",
      generatedAt: "2026-05-13T00:00:00.000Z",
      preflightRoute: {
        mode: "local-precommit-compatible",
        reportSource: "local security scan report",
        reportCommand: "npm run security:scan",
        githubMcp: {
          status: "not_evidenced",
          detail: "No GitHub MCP integration is wired into this route; it reads local baseline-security-scan.json output.",
        },
        ghasPromptCodePathScanning: {
          status: "not_supported",
          detail: "This route does not claim GitHub Advanced Security prompt scanning or runtime code-path scanning support.",
        },
      },
      secretScan: {
        status: "unsupported",
        summary: "gitleaks is not installed",
        findings: [],
      },
      dependencyScan: {
        status: "fail",
        summary: "npm audit summary: 0 critical, 1 high, 7 moderate, 0 low. Blocking npm audit advisories: fast-uri: fast-uri vulnerable to path traversal via percent-encoded dot segments (GHSA-q3j6-qgpj-74h6); fast-uri vulnerable to host confusion via percent-encoded authority delimiters (GHSA-v39h-62p7-jpjc).",
        findings: [
          {
            severity: "high",
            title: "npm audit found high or critical vulnerabilities",
            detail: "npm audit summary: 0 critical, 1 high, 7 moderate, 0 low. Blocking npm audit advisories: fast-uri: fast-uri vulnerable to path traversal via percent-encoded dot segments (GHSA-q3j6-qgpj-74h6); fast-uri vulnerable to host confusion via percent-encoded authority delimiters (GHSA-v39h-62p7-jpjc).",
          },
        ],
      },
    });
  });

  it("summarizes blocking dependency advisories with package and advisory details", () => {
    const summary = summarizeNpmAuditReport({
      vulnerabilities: {
        "fast-uri": {
          name: "fast-uri",
          severity: "high",
          via: [
            {
              title: "fast-uri vulnerable to path traversal via percent-encoded dot segments",
              url: "https://github.com/advisories/GHSA-q3j6-qgpj-74h6",
              severity: "high",
            },
            {
              title: "fast-uri vulnerable to host confusion via percent-encoded authority delimiters",
              url: "https://github.com/advisories/GHSA-v39h-62p7-jpjc",
              severity: "high",
            },
          ],
        },
      },
      metadata: {
        vulnerabilities: {
          low: 0,
          moderate: 7,
          high: 1,
          critical: 0,
        },
      },
    });

    expect(summary.blockingDetail).toContain("fast-uri");
    expect(summary.blockingDetail).toContain("GHSA-q3j6-qgpj-74h6");
    expect(summary.blockingDetail).toContain("GHSA-v39h-62p7-jpjc");
    expect(summary.blockingFindingDetails).toEqual([
      "fast-uri: fast-uri vulnerable to path traversal via percent-encoded dot segments (GHSA-q3j6-qgpj-74h6); fast-uri vulnerable to host confusion via percent-encoded authority delimiters (GHSA-v39h-62p7-jpjc)",
    ]);
  });
});
