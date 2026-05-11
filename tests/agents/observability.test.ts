import { describe, expect, it } from "vitest";
import { mapAgentObservabilityRows } from "@/agents/observability";

describe("mapAgentObservabilityRows", () => {
  it("maps agent observability data without exposing secret or raw content fields", () => {
    const result = mapAgentObservabilityRows({
      role: {
        slug: "dev-agent",
        name: "Developer Agent",
        department: "engineering",
        type: "executor",
        tools_config: { mcps: ["github", "context7"] },
      },
      recentTasks: [
        {
          id: "task-1",
          status: "completed",
          title: "Build control plane slice",
          created_at: "2026-05-10T23:00:00.000Z",
          started_at: "2026-05-10T23:01:00.000Z",
          completed_at: "2026-05-10T23:20:00.000Z",
          parent_task_id: null,
          goal_id: "goal-1",
          created_by: "scheduler",
          model_used: "openai-codex/gpt-5.5",
        },
      ],
      schedules: [
        {
          id: "schedule-1",
          cron_expression: "0 9 * * *",
          enabled: true,
          last_run_at: "2026-05-10T23:00:00.000Z",
          next_run_at: "2026-05-11T23:00:00.000Z",
          task_template: { kind: "current-tech-research-daily", assignedTo: "dev-agent", title: "Current tech" },
        },
      ],
      connectorInstalls: [
        {
          id: "install-1",
          connector_slug: "github",
          display_name: "Owner GitHub",
          status: "active",
          credential_id: "credential-secret",
          config: { token: "raw-secret", webhookUrl: "https://secret.example" },
        },
      ],
      roleMemory: [
        {
          id: "role-memory-1",
          source_task_id: "task-1",
          confidence: 0.9,
          sensitivity: "internal",
          created_at: "2026-05-10T23:21:00.000Z",
          updated_at: "2026-05-10T23:22:00.000Z",
          content: "raw role memory content",
        },
      ],
      hiveMemory: [
        {
          id: "hive-memory-1",
          source_task_id: "task-1",
          category: "general",
          confidence: 0.8,
          sensitivity: "confidential",
          created_at: "2026-05-10T23:21:00.000Z",
          updated_at: "2026-05-10T23:22:00.000Z",
          content: "raw hive memory content",
        },
      ],
      taskAttachments: [
        {
          id: "attachment-1",
          task_id: "task-1",
          filename: "brief.pdf",
          storage_path: "/private/raw/path/brief.pdf",
          mime_type: "application/pdf",
          size_bytes: 1234,
          uploaded_at: "2026-05-10T22:59:00.000Z",
        },
      ],
      workProducts: [
        {
          id: "work-product-1",
          task_id: "task-1",
          artifact_kind: "report",
          file_path: "/private/raw/path/report.md",
          mime_type: "text/markdown",
          sensitivity: "internal",
          created_at: "2026-05-10T23:20:00.000Z",
          content: "raw deliverable content",
          summary: "raw summary",
        },
      ],
    });

    expect(result.history.agentLevel.totalRuns).toBe(1);
    expect(result.history.agentLevel.statusCounts).toEqual({ completed: 1 });
    expect(result.history.taskLevel[0]).toMatchObject({
      id: "task-1",
      historyLevel: "task",
      status: "completed",
      startedAt: "2026-05-10T23:01:00.000Z",
      completedAt: "2026-05-10T23:20:00.000Z",
    });
    expect(result.scheduleState.kind).toBe("scheduled");
    expect(result.scheduleState.schedules[0]).toMatchObject({
      id: "schedule-1",
      enabled: true,
      lastRunAt: "2026-05-10T23:00:00.000Z",
      nextRunAt: "2026-05-11T23:00:00.000Z",
    });
    expect(result.tools).toEqual([
      { slug: "github", label: "GitHub", source: "role-mcp" },
      { slug: "context7", label: "Context7 Docs", source: "role-mcp" },
    ]);
    expect(result.connectedApps[0]).toEqual({
      id: "install-1",
      connectorSlug: "github",
      displayName: "Owner GitHub",
      status: "active",
    });
    expect(result.memory.roleMemory[0]).toEqual({
      id: "role-memory-1",
      sourceTaskId: "task-1",
      confidence: 0.9,
      sensitivity: "internal",
      createdAt: "2026-05-10T23:21:00.000Z",
      updatedAt: "2026-05-10T23:22:00.000Z",
    });
    expect(result.memory.hiveMemory[0]).not.toHaveProperty("content");
    expect(result.files.attachments[0]).not.toHaveProperty("storagePath");
    expect(result.files.workProducts[0]).toEqual({
      id: "work-product-1",
      taskId: "task-1",
      artifactKind: "report",
      fileLabel: "report.md",
      mimeType: "text/markdown",
      sensitivity: "internal",
      createdAt: "2026-05-10T23:20:00.000Z",
    });
  });

  it("returns explicit professional missing-data states", () => {
    const result = mapAgentObservabilityRows({
      role: {
        slug: "qa-agent",
        name: "QA Agent",
        department: "quality",
        type: "executor",
        tools_config: null,
      },
      recentTasks: [],
      schedules: [],
      connectorInstalls: [],
      roleMemory: [],
      hiveMemory: [],
      taskAttachments: [],
      workProducts: [],
    });

    expect(result.history.agentLevel.totalRuns).toBe(0);
    expect(result.history.emptyMessage).toBe("No agent-level run history has been recorded for this role.");
    expect(result.scheduleState).toEqual({
      kind: "no_schedule",
      label: "No schedule",
      message: "No schedule is configured for this agent in the selected scope.",
      schedules: [],
    });
    expect(result.tools).toEqual([
      { slug: "runtime-default", label: "Runtime default tool policy", source: "runtime-default" },
    ]);
    expect(result.connectedAppsEmptyMessage).toBe("No connected apps are installed in the selected hive.");
    expect(result.memory.emptyMessage).toBe("No linked memory metadata is available for this agent.");
    expect(result.files.emptyMessage).toBe("No linked file or artifact metadata is available for this agent.");
  });
});
