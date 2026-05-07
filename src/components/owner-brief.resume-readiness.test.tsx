// @vitest-environment jsdom

import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnerBrief } from "./owner-brief";

function renderBrief() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <OwnerBrief hiveId="hive-1" />
    </QueryClientProvider>,
  );
}

function briefPayload() {
  return {
    flags: {
      urgentDecisions: 0,
      pendingDecisions: 0,
      pendingQualityFeedback: 0,
      totalPendingDecisions: 0,
      stalledGoals: 0,
      waitingGoals: 0,
      atRiskGoals: 0,
      unresolvableTasks: 8,
      expiringCreds: 0,
    },
    pendingDecisions: [],
    goals: [],
    recentCompletions: [],
    newInsights: [],
    costs: { todayCents: 0, weekCents: 0, monthCents: 0 },
    activity: { tasksCompleted24h: 0, tasksFailed24h: 0, goalsCompleted7d: 0 },
    initiative: {
      latestRun: null,
      last7d: {
        windowHours: 168,
        runCount: 0,
        completedRuns: 0,
        failedRuns: 0,
        evaluatedCandidates: 0,
        createdItems: 0,
        suppressedItems: 0,
        runFailures: 0,
        suppressionReasons: [],
      },
    },
    operationLock: {
      creationPause: {
        paused: true,
        reason: "Manual recovery",
        pausedBy: "owner",
        updatedAt: "2026-05-02T00:00:00.000Z",
      },
      resumeReadiness: {
        status: "blocked",
        canResumeSafely: false,
        counts: {
          enabledSchedules: 0,
          runnableTasks: 3,
          pendingDecisions: 1,
          unresolvableTasks: 8,
        },
        models: {
          enabled: 2,
          ready: 1,
          blocked: 1,
          blockedRoutes: [{
            provider: "moonshot",
            adapterType: "openai-compatible",
            modelId: "kimi-2.6",
            canRun: false,
            reason: "health_probe_missing",
            status: "unknown",
            lastProbedAt: null,
            nextProbeAt: null,
            failureReason: "No probe row yet",
          }],
        },
        sessions: {
          persistentRoutes: 1,
          fallbackRoutes: 1,
          routes: [
            {
              provider: "openai",
              adapterType: "codex",
              modelId: "gpt-5.5",
              persistentSessions: true,
            },
            {
              provider: "google",
              adapterType: "gemini",
              modelId: "gemini-3.1-pro",
              persistentSessions: false,
            },
          ],
        },
        blockers: [
          {
            code: "runnable_tasks",
            label: "Runnable work is already queued",
            count: 3,
            detail: "Clear queued work before resuming autonomy.",
          },
          {
            code: "pending_decisions",
            label: "Owner decisions are pending",
            count: 1,
            detail: "Resolve owner-tier decisions first.",
          },
          {
            code: "model_health_blocked",
            label: "Models need fresh health evidence",
            count: 1,
            detail: "Probe configured models first.",
          },
        ],
        checkedAt: "2026-05-02T00:30:00.000Z",
      },
    },
    ideas: { openCount: 0, lastReviewAt: null },
    generatedAt: "2026-05-02T00:30:00.000Z",
  };
}

describe("OwnerBrief resume readiness", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => (
      new Response(JSON.stringify({ data: briefPayload() }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows paused hives why resume is blocked", async () => {
    renderBrief();

    expect(await screen.findByText("Resume readiness")).toBeTruthy();
    expect(screen.getByText("Blocked")).toBeTruthy();
    expect(screen.getByText(/1\/2 models ready/)).toBeTruthy();
    expect(screen.getByText(/1 persistent-session route/)).toBeTruthy();
    expect(screen.getByText(/1 fresh-session fallback/)).toBeTruthy();
    expect(screen.getByText("Runnable work is already queued")).toBeTruthy();
    expect(screen.getByText("Owner decisions are pending")).toBeTruthy();
    expect(screen.getByText("kimi-2.6")).toBeTruthy();
  });
});
