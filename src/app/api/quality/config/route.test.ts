import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireApiUser: vi.fn(),
  canAccessHive: vi.fn(),
  maybeRecordEaHiveSwitch: vi.fn(),
  loadOwnerFeedbackSamplingConfigState: vi.fn(),
  saveOwnerFeedbackSamplingConfig: vi.fn(),
}));

vi.mock("../../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../../_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

vi.mock("@/ea/native/hive-switch-audit", () => ({
  maybeRecordEaHiveSwitch: mocks.maybeRecordEaHiveSwitch,
}));

vi.mock("@/quality/owner-feedback-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/quality/owner-feedback-config")>();
  return {
    ...actual,
    loadOwnerFeedbackSamplingConfigState: mocks.loadOwnerFeedbackSamplingConfigState,
    saveOwnerFeedbackSamplingConfig: mocks.saveOwnerFeedbackSamplingConfig,
  };
});

import { GET, PATCH } from "./route";

const HIVE_ID = "aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa";

function patchRequest(body: unknown) {
  return new Request("http://localhost/api/quality/config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/quality/config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.loadOwnerFeedbackSamplingConfigState.mockResolvedValue({
      source: "hive",
      rawRow: { hiveId: HIVE_ID, config: { ai_peer_feedback_sample_rate: 0.15 } },
      effectiveConfig: {
        sampleRate: 0.08,
        aiPeerReviewSampleRate: 0.15,
        eligibilityWindowDays: 7,
        duplicateCooldownDays: 30,
        perRoleDailyCap: 2,
        perDayCap: 5,
      },
    });
  });

  it("returns the effective hive-scoped sampling config", async () => {
    const res = await GET(
      new Request(`http://localhost/api/quality/config?hiveId=${HIVE_ID}`),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.aiPeerFeedbackSampleRate).toBe(0.15);
    expect(body.data.effective.ai_peer_feedback_sample_rate).toBe(0.15);
    expect(body.data.source).toBe("hive");
  });

  it("rejects sample rates outside 0..1 before saving", async () => {
    const res = await PATCH(patchRequest({
      hiveId: HIVE_ID,
      ownerFeedbackSampleRate: 0.2,
      aiPeerFeedbackSampleRate: 1.1,
    }));

    expect(res.status).toBe(400);
    expect(mocks.saveOwnerFeedbackSamplingConfig).not.toHaveBeenCalled();
  });

  it("enforces hive access for authenticated non-owner callers", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "member-1", email: "member@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await PATCH(patchRequest({
      hiveId: HIVE_ID,
      ownerFeedbackSampleRate: 0.2,
      aiPeerFeedbackSampleRate: 0.1,
    }));

    expect(res.status).toBe(403);
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "member-1", HIVE_ID);
    expect(mocks.saveOwnerFeedbackSamplingConfig).not.toHaveBeenCalled();
  });

  it("saves valid sample-rate updates for the selected hive", async () => {
    const res = await PATCH(patchRequest({
      hiveId: HIVE_ID,
      ownerFeedbackSampleRate: 0.2,
      aiPeerFeedbackSampleRate: 0.1,
    }));

    expect(res.status).toBe(200);
    expect(mocks.saveOwnerFeedbackSamplingConfig).toHaveBeenCalledWith(
      mocks.sql,
      HIVE_ID,
      { ownerFeedbackSampleRate: 0.2, aiPeerFeedbackSampleRate: 0.1 },
    );
  });

  it("passes audit-header context through after saving", async () => {
    mocks.saveOwnerFeedbackSamplingConfig.mockResolvedValueOnce(
      "11111111-2222-4333-8444-555555555555",
    );
    const request = patchRequest({
      hiveId: HIVE_ID,
      ownerFeedbackSampleRate: 0.2,
      aiPeerFeedbackSampleRate: 0.1,
    });
    request.headers.set(
      "x-hivewright-ea-source-hive-id",
      "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
    );
    request.headers.set("x-hivewright-ea-source", "dashboard");

    const res = await PATCH(request);

    expect(res.status).toBe(200);
    expect(mocks.maybeRecordEaHiveSwitch).toHaveBeenCalledWith(
      mocks.sql,
      request,
      HIVE_ID,
      {
        type: "adapter_config",
        id: "11111111-2222-4333-8444-555555555555",
      },
    );
  });
});
