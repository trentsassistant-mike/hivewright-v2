import { sql } from "@/app/api/_lib/db";
import { requireApiUser, type AuthenticatedApiUser } from "@/app/api/_lib/auth";
import { jsonError, jsonOk } from "@/app/api/_lib/responses";
import { canAccessHive } from "@/auth/users";
import {
  DashboardEaTurnInProgressError,
  dashboardEaClient,
  getDashboardChat,
  sendDashboardMessage,
  startFreshDashboardThread,
} from "@/ea/native/dashboard-chat";
import {
  EA_MAX_ATTACHMENT_BYTES,
  stageDashboardEaAttachments,
} from "@/ea/native/attachments";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function authorizeHive(
  user: Pick<AuthenticatedApiUser, "id" | "isSystemOwner">,
  hiveId: string,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  if (!UUID_RE.test(hiveId)) {
    return { ok: false, response: jsonError("hiveId is invalid", 400) };
  }
  if (user.isSystemOwner) return { ok: true };
  const hasAccess = await canAccessHive(sql, user.id, hiveId);
  if (!hasAccess) {
    return {
      ok: false,
      response: jsonError("Forbidden: caller cannot access this hive", 403),
    };
  }
  return { ok: true };
}

async function loadHiveName(hiveId: string): Promise<string | null> {
  const [hive] = await sql<{ name: string }[]>`
    SELECT name FROM hives WHERE id = ${hiveId}
  `;
  return hive?.name ?? null;
}

function wantsEventStream(request: Request): boolean {
  return request.headers.get("accept")?.includes("text/event-stream") ?? false;
}

function sseFrame(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

function isMultipart(request: Request): boolean {
  return request.headers.get("content-type")?.includes("multipart/form-data") ?? false;
}

function validateDashboardEaFiles(files: File[]): string | null {
  const oversized = files.find((file) => file.size > EA_MAX_ATTACHMENT_BYTES);
  if (oversized) return `File "${oversized.name}" exceeds the 25 MB size limit.`;
  return null;
}

export async function GET(request: Request): Promise<Response> {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const url = new URL(request.url);
  const hiveId = url.searchParams.get("hiveId") ?? "";
  const authorization = await authorizeHive(authz.user, hiveId);
  if (!authorization.ok) return authorization.response;

  try {
    const hiveName = await loadHiveName(hiveId);
    if (!hiveName) return jsonError("Hive not found", 404);

    const limit = Number(url.searchParams.get("limit") ?? "40");
    const before = url.searchParams.get("before");
    const state = await getDashboardChat(sql, {
      hiveId,
      userId: authz.user.id,
      limit: Number.isFinite(limit) ? limit : 40,
      before,
    });
    return jsonOk(state);
  } catch {
    return jsonError("Failed to fetch EA chat", 500);
  }
}

export async function POST(request: Request): Promise<Response> {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  let payload: { hiveId?: unknown; content?: unknown };
  let files: File[] = [];
  try {
    if (isMultipart(request)) {
      const formData = await request.formData();
      payload = {
        hiveId: formData.get("hiveId"),
        content: formData.get("content"),
      };
      files = formData.getAll("files").filter((value): value is File => value instanceof File);
    } else {
      payload = await request.json() as { hiveId?: unknown; content?: unknown };
    }
  } catch {
    return isMultipart(request)
      ? jsonError("Invalid multipart body", 400)
      : jsonError("Invalid JSON body", 400);
  }
  const hiveId = typeof payload.hiveId === "string" ? payload.hiveId : "";
  const authorization = await authorizeHive(authz.user, hiveId);
  if (!authorization.ok) return authorization.response;

  const content = typeof payload.content === "string" ? payload.content.trim() : "";
  if (!content && files.length === 0) return jsonError("content is required", 400);
  if (content.length > 12_000) return jsonError("content is too long", 400);
  const fileError = validateDashboardEaFiles(files);
  if (fileError) return jsonError(fileError, 400);

  try {
    const hiveName = await loadHiveName(hiveId);
    if (!hiveName) return jsonError("Hive not found", 404);
    const stagedAttachments = await stageDashboardEaAttachments(
      `dashboard-${crypto.randomUUID()}`,
      files,
    );
    const messageContent = content || "Please review the attached file(s).";

    if (wantsEventStream(request)) {
      const stream = await dashboardEaClient.submit(messageContent, {
        hiveId,
        hiveName,
        attachments: stagedAttachments,
        signal: request.signal,
      });

      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              controller.enqueue(sseFrame({ type: "start" }));
              for await (const chunk of stream) {
                controller.enqueue(sseFrame({ type: "delta", delta: chunk }));
              }
              controller.enqueue(sseFrame({ type: "done" }));
            } catch {
              controller.enqueue(sseFrame({ type: "error" }));
            } finally {
              controller.close();
            }
          },
        }),
        {
          status: 201,
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          },
        },
      );
    }

    const result = await sendDashboardMessage(sql, {
      hiveId,
      hiveName,
      userId: authz.user.id,
      content: messageContent,
      attachments: stagedAttachments,
      signal: request.signal,
    });
    return jsonOk(result, 201);
  } catch (error) {
    if (error instanceof DashboardEaTurnInProgressError) {
      return jsonError("EA is already responding", 409);
    }
    return jsonError("Failed to send EA message", 500);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const url = new URL(request.url);
  const hiveId = url.searchParams.get("hiveId") ?? "";
  const authorization = await authorizeHive(authz.user, hiveId);
  if (!authorization.ok) return authorization.response;

  try {
    const hiveName = await loadHiveName(hiveId);
    if (!hiveName) return jsonError("Hive not found", 404);

    const thread = await startFreshDashboardThread(sql, {
      hiveId,
      userId: authz.user.id,
    });
    return jsonOk({ thread, messages: [], hasMore: false });
  } catch {
    return jsonError("Failed to start fresh EA thread", 500);
  }
}
