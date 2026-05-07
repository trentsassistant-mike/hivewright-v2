import { sql } from "../../_lib/db";
import { jsonError, jsonOk } from "../../_lib/responses";
import { requireApiAuth } from "../../_lib/auth";
import { proposeSkill } from "@/skills/self-creation";

/**
 * POST /api/skills/import
 *
 * Owner-facing "workflow capture" endpoint. Converts a pasted SOP (free
 * text or pre-formatted SKILL.md) into a pending skill draft. The existing
 * skill-self-creation pipeline picks it up from there (QA review → approve
 * → promote to hive or system skills).
 *
 * Body: { hiveId, title, scope ('hive'|'system'), content, sourceRole? }
 */
export async function POST(request: Request) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;
  try {
    const body = await request.json();
    const { hiveId, title, scope, content, sourceRole } = body as {
      hiveId?: string;
      title?: string;
      scope?: string;
      content?: string;
      sourceRole?: string;
    };

    if (!hiveId || !title || !content) {
      return jsonError("hiveId, title and content are required", 400);
    }
    const effectiveScope = scope === "system" ? "system" : "hive";

    const slug = slugify(title);
    if (!slug) return jsonError("title must contain at least one alphanumeric character", 400);

    const normalised = normaliseSkillContent(title, content);
    const role = sourceRole ?? "owner";

    const draft = await proposeSkill(sql, {
      hiveId,
      roleSlug: role,
      sourceTaskId: undefined,
      slug,
      content: normalised,
      scope: effectiveScope,
    });

    return jsonOk(
      {
        id: draft.id,
        slug: draft.slug,
        status: draft.status,
      },
      201,
    );
  } catch (err) {
    console.error("[api/skills/import]", err);
    const msg = err instanceof Error ? err.message : "Failed to import SOP";
    return jsonError(msg, 500);
  }
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

/**
 * If the content is already SKILL.md-shaped (has an H1 title and at least
 * one section heading) leave it alone. Otherwise wrap it in a minimal
 * SKILL.md frame so the downstream loader is happy.
 */
function normaliseSkillContent(title: string, raw: string): string {
  const trimmed = raw.trim();
  if (/^#\s+\S/.test(trimmed) && /^##\s+\S/m.test(trimmed)) {
    return trimmed;
  }
  return `# ${title}\n\n## How to use this skill\n\n${trimmed}\n`;
}
