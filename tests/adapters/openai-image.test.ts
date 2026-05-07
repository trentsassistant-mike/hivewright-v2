import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GPT_IMAGE_2_MODEL,
  GPT_IMAGE_2_SNAPSHOT,
  OpenAIImageAdapter,
  buildImagePrompt,
  normalizeImageSize,
  normalizeImagesUsage,
  parseStructuredImageRequest,
  validateGptImage2Model,
} from "@/adapters/openai-image";
import { sanitizeProviderText } from "@/adapters/openai-auth";
import type { SessionContext } from "@/adapters/types";

const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

const originalOpenAIKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  if (originalOpenAIKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAIKey;
  }
  vi.restoreAllMocks();
});

function makeContext(workspace: string, overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    task: {
      id: "11111111-1111-4111-8111-111111111111",
      hiveId: "22222222-2222-4222-8222-222222222222",
      assignedTo: "image-designer",
      createdBy: "owner",
      status: "active",
      priority: 5,
      title: "Generate hero image",
      brief: JSON.stringify({
        intent: "Generate a HiveWright honeycomb hero image",
        references: ["amber hexagon pattern"],
        dimensions: { width: 1024, height: 1024 },
        style: "vibrant but not overpowering",
        taskConstraints: ["no text"],
        projectConstraints: ["use for dashboard visual direction"],
      }),
      parentTaskId: null,
      goalId: null,
      sprintNumber: null,
      qaRequired: false,
      acceptanceCriteria: null,
      retryCount: 0,
      doctorAttempts: 0,
      failureReason: null,
      projectId: null,
    },
    roleTemplate: {
      slug: "image-designer",
      department: "design",
      roleMd: null,
      soulMd: null,
      toolsMd: null,
    },
    memoryContext: { roleMemory: [], hiveMemory: [], insights: [], capacity: "0/200" },
    skills: [],
    standingInstructions: [],
    goalContext: null,
    projectWorkspace: workspace,
    hiveWorkspacePath: workspace,
    model: GPT_IMAGE_2_MODEL,
    fallbackModel: null,
    primaryAdapterType: "openai-image",
    credentials: { OPENAI_API_KEY: "sk-test-image-key" },
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: { "Content-Type": "application/json" },
  });
}

describe("OpenAIImageAdapter Images API runtime", () => {
  it("includes the shared hive context in generated image prompts", () => {
    const ctx = makeContext("/tmp/hw-image", {
      hiveContext: "## Hive Context\n**Hive:** HiveWright\n**Working in:** /tmp/hw-image",
    });

    const prompt = buildImagePrompt(ctx, parseStructuredImageRequest(ctx.task.brief));

    expect(prompt).toContain("## Hive Context");
    expect(prompt).toContain("**Working in:** /tmp/hw-image");
    expect(prompt).toContain("Intent: Generate a HiveWright honeycomb hero image");
  });

  it("calls the OpenAI Images API with gpt-image-2 and stores the returned PNG as a binary artifact", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hw-openai-image-workspace-"));
    const fetchMock = vi.fn(async () => jsonResponse({
      data: [{ b64_json: ONE_BY_ONE_PNG_BASE64, revised_prompt: "A honeycomb hero" }],
      usage: {
        total_tokens: 3_500,
        input_tokens: 2_500,
        output_tokens: 1_000,
        input_tokens_details: { text_tokens: 2_500, image_tokens: 0 },
      },
    }));

    try {
      const result = await new OpenAIImageAdapter({ fetch: fetchMock as never }).execute(makeContext(workspace));

      expect(result.success).toBe(true);
      expect(result.modelUsed).toBe(GPT_IMAGE_2_SNAPSHOT);
      expect(result.tokensInput).toBe(2_500);
      expect(result.tokensOutput).toBe(1_000);
      expect(result.costCents).toBe(5);
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts?.[0]).toMatchObject({
        kind: "image",
        mimeType: "image/png",
        width: 1,
        height: 1,
        modelName: GPT_IMAGE_2_MODEL,
        modelSnapshot: GPT_IMAGE_2_SNAPSHOT,
        promptTokens: 2_500,
        outputTokens: 1_000,
        costCents: 5,
      });
      expect(result.artifacts?.[0]?.metadata).toMatchObject({
        source: "openai-images-api",
        modelName: GPT_IMAGE_2_MODEL,
        modelSnapshot: GPT_IMAGE_2_SNAPSHOT,
        revisedPrompt: "A honeycomb hero",
        usage: {
          promptTokens: 2_500,
          outputTokens: 1_000,
          costCents: 5,
        },
      });
      expect(result.artifacts?.[0]?.path).toContain(path.join(workspace, "11111111-1111-4111-8111-111111111111", "images"));
      expect(fs.existsSync(result.artifacts?.[0]?.path ?? "")).toBe(true);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      const [url, init] = call;
      expect(url).toBe("https://api.openai.com/v1/images/generations");
      expect(init.method).toBe("POST");
      expect(init.headers).toMatchObject({
        Authorization: "Bearer sk-test-image-key",
        "Content-Type": "application/json",
      });
      const requestBody = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(requestBody).toMatchObject({
        model: GPT_IMAGE_2_MODEL,
        n: 1,
        size: "1024x1024",
        output_format: "png",
        user: "11111111-1111-4111-8111-111111111111",
      });
      expect(requestBody.prompt).toContain("Intent: Generate a HiveWright honeycomb hero image");
      expect(requestBody.model).not.toBe("gpt-image-1");
      expect(requestBody.model).not.toBe("dall-e-3");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("normalizes partial usage and still returns a cost record", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hw-openai-image-workspace-"));
    const fetchMock = vi.fn(async () => jsonResponse({
      data: [{ b64_json: ONE_BY_ONE_PNG_BASE64 }],
      usage: { input_tokens: 1_250 },
    }));

    try {
      const result = await new OpenAIImageAdapter({ fetch: fetchMock as never }).execute(makeContext(workspace));
      expect(result.success).toBe(true);
      expect(result.tokensInput).toBe(1_250);
      expect(result.tokensOutput).toBe(0);
      expect(result.costCents).toBe(1);
      expect(result.artifacts?.[0]?.costCents).toBe(1);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("normalizes missing usage to zero without losing the explicit cost surface", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hw-openai-image-workspace-"));
    const fetchMock = vi.fn(async () => jsonResponse({
      data: [{ b64_json: ONE_BY_ONE_PNG_BASE64 }],
    }));

    try {
      const result = await new OpenAIImageAdapter({ fetch: fetchMock as never }).execute(makeContext(workspace));
      expect(result.success).toBe(true);
      expect(result.tokensInput).toBe(0);
      expect(result.tokensOutput).toBe(0);
      expect(result.costCents).toBe(0);
      expect(result.artifacts?.[0]?.metadata?.usage).toMatchObject({
        promptTokens: 0,
        outputTokens: 0,
        costCents: 0,
      });
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("fails closed before the API call when a legacy image model is configured", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hw-openai-image-workspace-"));
    const fetchMock = vi.fn();

    try {
      const result = await new OpenAIImageAdapter({ fetch: fetchMock as never }).execute(
        makeContext(workspace, { model: "gpt-image-1" }),
      );

      expect(result.success).toBe(false);
      expect(result.failureReason).toContain("forbidden");
      expect(result.failureReason).toContain(GPT_IMAGE_2_MODEL);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("redacts secret-bearing API output before returning failures", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hw-openai-image-workspace-"));
    const fakeOpenAIKey = `sk-${"a".repeat(30)}`;
    const fetchMock = vi.fn(async () => new Response(`bad bearer ${fakeOpenAIKey}`, {
      status: 401,
      statusText: "Unauthorized",
    }));

    try {
      const result = await new OpenAIImageAdapter({ fetch: fetchMock as never }).execute(makeContext(workspace));
      expect(result.success).toBe(false);
      expect(result.failureReason).not.toContain(fakeOpenAIKey);
      expect(sanitizeProviderText(result.failureReason ?? "")).toBe(result.failureReason);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("accepts the structured image request shape", () => {
    const request = parseStructuredImageRequest(JSON.stringify({
      intent: "concept",
      references: ["ref-a"],
      dimensions: { width: 1536, height: 1024 },
      style: "editorial",
      constraints: ["no text"],
      taskConstraints: ["png"],
      projectConstraints: ["HiveWright"],
    }));
    expect(request.intent).toBe("concept");
    expect(request.references).toEqual(["ref-a"]);
    expect(request.constraints).toEqual(["no text"]);
    expect(normalizeImageSize(request.dimensions)).toBe("1536x1024");
  });

  it("calculates normalized image usage at $8/M input and $30/M output", () => {
    expect(normalizeImagesUsage({
      total_tokens: 3_500,
      input_tokens: 2_500,
      output_tokens: 1_000,
      input_tokens_details: { text_tokens: 2_000, image_tokens: 500 },
    })).toEqual({
      promptTokens: 2_500,
      outputTokens: 1_000,
      totalTokens: 3_500,
      inputTextTokens: 2_000,
      inputImageTokens: 500,
      costCents: 5,
    });
    expect(normalizeImagesUsage(undefined)).toMatchObject({
      promptTokens: 0,
      outputTokens: 0,
      costCents: 0,
    });
  });

  it("guards the adapter implementation against legacy image model constants", () => {
    expect(validateGptImage2Model("gpt-image-2")).toBeNull();
    expect(validateGptImage2Model("gpt-image-2-2026-04-21")).toBeNull();
    expect(validateGptImage2Model("gpt-image-1")).toContain("forbidden");
    expect(validateGptImage2Model("dall-e-3")).toContain("forbidden");

    const source = fs.readFileSync(path.join(process.cwd(), "src/adapters/openai-image.ts"), "utf-8");
    expect(source).toContain("https://api.openai.com/v1/images/generations");
    expect(source).toContain("model: GPT_IMAGE_2_MODEL");
    expect(source).not.toMatch(/model:\s*["']gpt-image-1["']/);
    expect(source).not.toMatch(/model:\s*["']dall-e-3["']/i);
  });
});
