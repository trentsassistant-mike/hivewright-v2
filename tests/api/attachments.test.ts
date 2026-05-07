import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs";
import { POST } from "@/app/api/work/route";
import { testSql as sql, truncateAll } from "../_lib/test-db";

// Stub the classifier so these tests don't attempt real LLM calls.
// The mock mimics the old keyword-based heuristic for backwards compatibility.
vi.mock("@/work-intake/runner", () => ({
  runClassifier: vi.fn(async (_sql: unknown, input: string) => {
    const lower = input.toLowerCase();
    const goalKeywords = ["strategy", "plan", "build", "create", "develop", "design", "launch",
      "implement across", "comprehensive", "complete", "full", "entire", "all pages",
      "research and", "analyze and", "multiple", "phases"];
    const sentenceCount = input.split(/[.!?]+/).filter((s: string) => s.trim().length > 0).length;
    const hasGoalKw = goalKeywords.some((kw) => lower.includes(kw));
    const isGoal = (sentenceCount >= 3 && hasGoalKw) || (input.length > 200 && hasGoalKw);
    return {
      result: isGoal
        ? { type: "goal", confidence: 0.85, reasoning: "goal keywords detected" }
        : { type: "task", role: "dev-agent", confidence: 0.85, reasoning: "short task" },
      attempts: [],
      usedFallback: false,
      providerUsed: "ollama",
      modelUsed: "qwen3:32b",
    };
  }),
}));

const TEST_SLUG = "test-biz-attachments";

let bizId: string;

beforeEach(async () => {
  await truncateAll(sql);
  const [biz] = await sql`
    INSERT INTO hives (slug, name, type, workspace_path)
    VALUES (${TEST_SLUG}, 'Attachment Test Biz', 'digital', '/tmp')
    RETURNING *
  `;
  bizId = biz.id;
});

afterAll(() => {
  const dir = "/home/example/hives/test-biz-attachments";
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/work — multipart with attachment", () => {
  it("creates task + attachment row + file on disk for uploaded image", async () => {
    const imageBytes = Buffer.from("fake-png-data");
    const formData = new FormData();
    formData.append("hiveId", bizId);
    formData.append("input", "Fix the login button styles");
    formData.append(
      "files",
      new File([imageBytes], "screenshot.png", { type: "image/png" })
    );

    const request = new Request("http://localhost/api/work", {
      method: "POST",
      body: formData,
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.data.type).toBe("task");

    const taskId = body.data.id as string;

    // Task exists in DB
    const tasks = await sql`SELECT id FROM tasks WHERE id = ${taskId}`;
    expect(tasks.length).toBe(1);

    // Attachment row exists
    const attachments = await sql`
      SELECT * FROM task_attachments WHERE task_id = ${taskId}
    `;
    expect(attachments.length).toBe(1);
    expect(attachments[0].filename).toBe("screenshot.png");
    expect(attachments[0].mime_type).toBe("image/png");
    expect(Number(attachments[0].size_bytes)).toBe(imageBytes.length);

    // File exists on disk at the stored path
    const storagePath = attachments[0].storage_path as string;
    expect(fs.existsSync(storagePath)).toBe(true);
    expect(fs.readFileSync(storagePath)).toEqual(imageBytes);
  });

  it("preserves JSON path when no files are submitted", async () => {
    const request = new Request("http://localhost/api/work", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hiveId: bizId, input: "Write a unit test" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data.type).toBe("task");
  });

  it("creates goal + goal-scoped attachment when classifier picks goal", async () => {
    const docBytes = Buffer.from("design-doc-bytes");
    const formData = new FormData();
    formData.append("hiveId", bizId);
    // Triggers goal classification: ≥3 sentences + goal keyword.
    formData.append(
      "input",
      "Design and build a comprehensive marketing site. Plan the entire site map. Launch with full content for all pages.",
    );
    formData.append(
      "files",
      new File([docBytes], "brief.pdf", { type: "application/pdf" }),
    );

    const request = new Request("http://localhost/api/work", {
      method: "POST",
      body: formData,
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.data.type).toBe("goal");

    const goalId = body.data.id as string;

    const attachments = await sql`
      SELECT * FROM task_attachments WHERE goal_id = ${goalId}
    `;
    expect(attachments.length).toBe(1);
    expect(attachments[0].task_id).toBeNull();
    expect(attachments[0].filename).toBe("brief.pdf");

    const storagePath = attachments[0].storage_path as string;
    expect(fs.existsSync(storagePath)).toBe(true);
    expect(fs.readFileSync(storagePath)).toEqual(docBytes);
  });

  it("rejects when more than 10 files are submitted", async () => {
    const formData = new FormData();
    formData.append("hiveId", bizId);
    formData.append("input", "test input");
    for (let i = 0; i < 11; i++) {
      formData.append(
        "files",
        new File(["x"], `file${i}.txt`, { type: "text/plain" }),
      );
    }

    const request = new Request("http://localhost/api/work", {
      method: "POST",
      body: formData,
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Too many files");
  });

  it("rejects when a file exceeds 25 MB", async () => {
    const bigBytes = Buffer.alloc(26 * 1024 * 1024); // 26 MB
    const formData = new FormData();
    formData.append("hiveId", bizId);
    formData.append("input", "test input");
    formData.append(
      "files",
      new File([bigBytes], "huge.bin", { type: "application/octet-stream" }),
    );

    const request = new Request("http://localhost/api/work", {
      method: "POST",
      body: formData,
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("25 MB");
  });
});
