import type { Adapter, AdapterProbeCredential, AdapterResult, ChunkCallback, ProbeResult, SessionContext } from "./types";
import { calculateCostCents } from "./provider-config";
import { resolveOpenAIAuth, sanitizeProviderText } from "./openai-auth";
import { storeTaskImage } from "../work-products/image-storage";
import { healthyProbeResult, probeResultFromBoundaryError, unhealthyProbeResult } from "./probe-classifier";

export const GPT_IMAGE_2_MODEL = "gpt-image-2";
export const GPT_IMAGE_2_SNAPSHOT = "gpt-image-2-2026-04-21";
const OPENAI_IMAGE_GENERATIONS_URL = "https://api.openai.com/v1/images/generations";

export interface StructuredImageRequest {
  intent: string;
  references?: string[];
  dimensions?: {
    width?: number;
    height?: number;
    size?: string;
  };
  style?: string;
  constraints?: string[];
  taskConstraints?: string[];
  projectConstraints?: string[];
}

export interface OpenAIImagesUsage {
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: {
    text_tokens?: number;
    image_tokens?: number;
  };
}

export interface NormalizedImageUsage {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputTextTokens: number | null;
  inputImageTokens: number | null;
  costCents: number;
}

interface OpenAIImagesResponse {
  data?: Array<{
    b64_json?: string;
    revised_prompt?: string;
  }>;
  usage?: OpenAIImagesUsage;
}

interface OpenAIImageDeps {
  fetch?: typeof fetch;
  endpoint?: string;
}

export class OpenAIImageAdapter implements Adapter {
  supportsPersistence = false;
  private readonly fetchFn: typeof fetch;
  private readonly endpoint: string;

  constructor(deps: OpenAIImageDeps = {}) {
    this.fetchFn = deps.fetch ?? fetch;
    this.endpoint = deps.endpoint ?? OPENAI_IMAGE_GENERATIONS_URL;
  }

  async probe(modelId: string, credential: AdapterProbeCredential): Promise<ProbeResult> {
    const startedAt = Date.now();
    const modelFailure = validateGptImage2Model(modelId);
    if (modelFailure) {
      return unhealthyProbeResult({
        failureClass: "unknown",
        reason: {
          code: "invalid_image_model",
          message: modelFailure,
          retryable: false,
        },
        latencyMs: 0,
      });
    }

    const auth = resolveOpenAIAuth(credential.secrets);
    if (!auth) {
      return unhealthyProbeResult({
        failureClass: "auth",
        reason: {
          code: "missing_openai_api_key",
          message: "OpenAI image probe requires OPENAI_API_KEY.",
          retryable: false,
        },
        latencyMs: 0,
      });
    }

    try {
      const response = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${auth.bearerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: GPT_IMAGE_2_MODEL,
          prompt: "health check",
          n: 1,
          size: "1024x1024",
          output_format: "png",
        }),
      });
      const latencyMs = Date.now() - startedAt;
      const raw = await response.text();
      if (response.ok) {
        return healthyProbeResult({ latencyMs, costEstimateUsd: 0.01 });
      }
      return probeResultFromBoundaryError({
        statusCode: response.status,
        message: sanitizeProviderText(raw),
        latencyMs,
      });
    } catch (err) {
      return probeResultFromBoundaryError({
        message: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - startedAt,
      });
    }
  }

  translate(ctx: SessionContext): string {
    const request = parseStructuredImageRequest(ctx.task.brief);
    return buildImagePrompt(ctx, request);
  }

  async execute(ctx: SessionContext, onChunk?: ChunkCallback): Promise<AdapterResult> {
    if (!ctx.hiveWorkspacePath) {
      return {
        success: false,
        output: "",
        failureReason: "Hive workspace path is required for image artifact storage",
      };
    }

    const modelFailure = validateGptImage2Model(ctx.model);
    if (modelFailure) {
      return {
        success: false,
        output: "",
        failureReason: modelFailure,
        failureKind: "unknown",
        modelUsed: GPT_IMAGE_2_SNAPSHOT,
      };
    }

    const auth = resolveOpenAIAuth(ctx.credentials);
    if (!auth) {
      return {
        success: false,
        output: "",
        failureReason: "OpenAI Images API requires OPENAI_API_KEY for gpt-image-2 generation.",
        failureKind: "spawn_error",
        modelUsed: GPT_IMAGE_2_SNAPSHOT,
      };
    }

    const request = parseStructuredImageRequest(ctx.task.brief);
    const prompt = buildImagePrompt(ctx, request);
    const size = normalizeImageSize(request.dimensions);
    await onChunk?.({ type: "status", text: `Generating one image through OpenAI Images API with ${GPT_IMAGE_2_SNAPSHOT}` });

    let response: Response;
    try {
      response = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${auth.bearerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: GPT_IMAGE_2_MODEL,
          prompt,
          n: 1,
          size,
          output_format: "png",
          user: ctx.task.id,
        }),
      });
    } catch (err) {
      return {
        success: false,
        output: "",
        failureReason: sanitizeProviderText(`OpenAI Images API request failed: ${(err as Error).message}`),
        failureKind: "spawn_error",
        modelUsed: GPT_IMAGE_2_SNAPSHOT,
      };
    }

    const raw = await response.text();
    const safeRaw = sanitizeProviderText(raw);
    if (!response.ok) {
      return {
        success: false,
        output: safeRaw,
        failureReason: `OpenAI Images API failed: ${response.status} ${response.statusText} ${safeRaw.slice(0, 500)}`.trim(),
        failureKind: "unknown",
        modelUsed: GPT_IMAGE_2_SNAPSHOT,
      };
    }

    let payload: OpenAIImagesResponse;
    try {
      payload = JSON.parse(raw) as OpenAIImagesResponse;
    } catch {
      return {
        success: false,
        output: safeRaw,
        failureReason: "OpenAI Images API returned non-JSON output.",
        failureKind: "unknown",
        modelUsed: GPT_IMAGE_2_SNAPSHOT,
      };
    }

    const imageBase64 = payload.data?.find((image) => typeof image.b64_json === "string" && image.b64_json.length > 0)?.b64_json;
    if (!imageBase64) {
      const usage = normalizeImagesUsage(payload.usage);
      return {
        success: false,
        output: safeRaw,
        failureReason: "OpenAI Images API returned no b64_json image data.",
        failureKind: "unknown",
        tokensInput: usage.promptTokens,
        tokensOutput: usage.outputTokens,
        costCents: usage.costCents,
        modelUsed: GPT_IMAGE_2_SNAPSHOT,
      };
    }

    const usage = normalizeImagesUsage(payload.usage);
    const stored = await storeTaskImage({
      hiveWorkspacePath: ctx.hiveWorkspacePath,
      taskId: ctx.task.id,
      imageBase64,
      fileStem: `openai-gpt-image-2-${Date.now()}`,
    });

    const output = [
      `Generated image artifact: ${stored.filePath}`,
      `MIME type: ${stored.mimeType}`,
      `Dimensions: ${stored.width}x${stored.height}`,
      `Model: ${GPT_IMAGE_2_MODEL}`,
      `Model snapshot: ${GPT_IMAGE_2_SNAPSHOT}`,
      `Usage: ${JSON.stringify(usage)}`,
    ].join("\n");

    return {
      success: true,
      output,
      tokensInput: usage.promptTokens,
      tokensOutput: usage.outputTokens,
      costCents: usage.costCents,
      modelUsed: GPT_IMAGE_2_SNAPSHOT,
      artifacts: [
        {
          kind: "image",
          path: stored.filePath,
          mimeType: stored.mimeType,
          width: stored.width,
          height: stored.height,
          modelName: GPT_IMAGE_2_MODEL,
          modelSnapshot: GPT_IMAGE_2_SNAPSHOT,
          promptTokens: usage.promptTokens,
          outputTokens: usage.outputTokens,
          costCents: usage.costCents,
          metadata: {
            modelName: GPT_IMAGE_2_MODEL,
            modelSnapshot: GPT_IMAGE_2_SNAPSHOT,
            size,
            originalRequest: request,
            originalBrief: ctx.task.brief,
            prompt,
            revisedPrompt: payload.data?.[0]?.revised_prompt ?? null,
            usage,
            sizeBytes: stored.sizeBytes,
            source: "openai-images-api",
          },
        },
      ],
    };
  }
}

export function validateGptImage2Model(model: string | null | undefined): string | null {
  if (model === GPT_IMAGE_2_MODEL || model === GPT_IMAGE_2_SNAPSHOT) return null;
  if (/gpt-image-1|dall[-\s]?e[-\s]?3|dall-e-2/i.test(model ?? "")) {
    return `Unsafe image model '${model}' is forbidden. Use ${GPT_IMAGE_2_MODEL} (${GPT_IMAGE_2_SNAPSHOT}) only.`;
  }
  return `openai-image adapter requires ${GPT_IMAGE_2_MODEL} (${GPT_IMAGE_2_SNAPSHOT}); received '${model ?? ""}'.`;
}

export function normalizeImagesUsage(usage: OpenAIImagesUsage | null | undefined): NormalizedImageUsage {
  const promptTokens = nonNegativeInt(usage?.input_tokens);
  const outputTokens = nonNegativeInt(usage?.output_tokens);
  const totalTokens = nonNegativeInt(usage?.total_tokens) || promptTokens + outputTokens;
  const inputTextTokens = usage?.input_tokens_details?.text_tokens;
  const inputImageTokens = usage?.input_tokens_details?.image_tokens;
  return {
    promptTokens,
    outputTokens,
    totalTokens,
    inputTextTokens: typeof inputTextTokens === "number" && inputTextTokens >= 0 ? Math.trunc(inputTextTokens) : null,
    inputImageTokens: typeof inputImageTokens === "number" && inputImageTokens >= 0 ? Math.trunc(inputImageTokens) : null,
    costCents: calculateCostCents(GPT_IMAGE_2_SNAPSHOT, promptTokens, outputTokens),
  };
}

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export function parseStructuredImageRequest(brief: string): StructuredImageRequest {
  const trimmed = brief.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    try {
      const parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)) as Partial<StructuredImageRequest>;
      if (typeof parsed.intent === "string" && parsed.intent.trim().length > 0) {
        return {
          intent: parsed.intent.trim(),
          references: Array.isArray(parsed.references)
            ? parsed.references.filter((r): r is string => typeof r === "string" && r.trim().length > 0)
            : [],
          dimensions: parsed.dimensions,
          style: typeof parsed.style === "string" ? parsed.style : undefined,
          constraints: Array.isArray(parsed.constraints)
            ? parsed.constraints.filter((r): r is string => typeof r === "string" && r.trim().length > 0)
            : [],
          taskConstraints: Array.isArray(parsed.taskConstraints)
            ? parsed.taskConstraints.filter((r): r is string => typeof r === "string" && r.trim().length > 0)
            : [],
          projectConstraints: Array.isArray(parsed.projectConstraints)
            ? parsed.projectConstraints.filter((r): r is string => typeof r === "string" && r.trim().length > 0)
            : [],
        };
      }
    } catch {
      // Fall through to plain-brief prompt construction.
    }
  }

  return { intent: trimmed };
}

export function buildImagePrompt(ctx: SessionContext, request: StructuredImageRequest): string {
  const lines = [
    ctx.hiveContext?.trim() ? ctx.hiveContext.trim() : null,
    `Intent: ${request.intent}`,
    request.style ? `Style: ${request.style}` : null,
    request.references?.length ? `References: ${request.references.join("; ")}` : null,
    request.constraints?.length ? `Constraints: ${request.constraints.join("; ")}` : null,
    request.taskConstraints?.length ? `Task constraints: ${request.taskConstraints.join("; ")}` : null,
    request.projectConstraints?.length ? `Project constraints: ${request.projectConstraints.join("; ")}` : null,
    ctx.goalContext ? `Goal context: ${ctx.goalContext}` : null,
    "Return a production-ready PNG or JPEG image artifact. Do not include text overlays unless the request explicitly requires them.",
  ];

  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

export function normalizeImageSize(dimensions: StructuredImageRequest["dimensions"]): string {
  if (dimensions?.size) return dimensions.size;
  const width = dimensions?.width;
  const height = dimensions?.height;
  if (width === 1536 && height === 1024) return "1536x1024";
  if (width === 1024 && height === 1536) return "1024x1536";
  if (width === 1024 && height === 1024) return "1024x1024";
  return "1024x1024";
}
