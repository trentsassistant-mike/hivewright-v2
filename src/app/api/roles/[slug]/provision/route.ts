import { sql } from "../../../_lib/db";
import { jsonError } from "../../../_lib/responses";
import { requireApiAuth } from "../../../_lib/auth";
import { provisionerFor } from "../../../../../provisioning";
import { invalidate as invalidateRoleStatus } from "../../../../../provisioning/status-cache";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;
  const { slug } = await params;

  const [row] = await sql`
    SELECT adapter_type, recommended_model FROM role_templates WHERE slug = ${slug}
  `;
  if (!row) return jsonError("role not found", 404);

  const provisioner = provisionerFor(row.adapter_type);
  if (!provisioner) return jsonError(`unsupported adapter '${row.adapter_type}'`, 400);

  const input = { slug, recommendedModel: row.recommended_model ?? "" };
  const encoder = new TextEncoder();

  let aborted = false;
  request.signal.addEventListener("abort", () => { aborted = true; });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const ev of provisioner.provision(input)) {
          if (aborted) break;
          const eventName = ev.phase === "done" ? "done" : "progress";
          const data = JSON.stringify(ev);
          try {
            controller.enqueue(encoder.encode(`event: ${eventName}\ndata: ${data}\n\n`));
          } catch {
            // Controller closed (client disconnected mid-write). Stop pulling.
            aborted = true;
            break;
          }
        }
      } catch (e) {
        if (!aborted) {
          const data = JSON.stringify({ phase: "done", status: { satisfied: false, fixable: false, reason: (e as Error).message } });
          try { controller.enqueue(encoder.encode(`event: done\ndata: ${data}\n\n`)); } catch { /* ignored — client gone */ }
        }
      } finally {
        invalidateRoleStatus(slug);
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
    },
  });
}
