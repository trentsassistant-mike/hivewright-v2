import { sql } from "../../_lib/db";
import { jsonOk, jsonError } from "../../_lib/responses";
import { requireApiUser } from "../../_lib/auth";
import { canAccessHive } from "@/auth/users";

type ProjectRow = {
  id: string;
  hive_id: string;
  slug: string;
  name: string;
  workspace_path: string | null;
  git_repo: boolean;
  created_at: Date;
  updated_at: Date;
};

function mapProjectRow(r: ProjectRow) {
  return {
    id: r.id,
    hiveId: r.hive_id,
    slug: r.slug,
    name: r.name,
    workspacePath: r.workspace_path,
    gitRepo: r.git_repo,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  try {
    const { id } = await params;

    const rows = await sql`
      SELECT id, hive_id, slug, name, workspace_path, git_repo, created_at, updated_at
      FROM projects
      WHERE id = ${id}
    `;

    if (rows.length === 0) {
      return jsonError("Project not found", 404);
    }
    const project = rows[0] as unknown as ProjectRow;
    if (!user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, user.id, project.hive_id);
      if (!hasAccess) {
        return jsonError("Forbidden: caller cannot access this hive", 403);
      }
    }

    return jsonOk(mapProjectRow(project));
  } catch {
    return jsonError("Failed to fetch project", 500);
  }
}
