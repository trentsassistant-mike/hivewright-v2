import { sql } from "../_lib/db";
import { jsonOk, jsonError, jsonPaginated, parseSearchParams } from "../_lib/responses";
import { requireApiUser } from "../_lib/auth";
import { canAccessHive } from "@/auth/users";
import { hiveProjectsPath, resolveHiveWorkspaceRoot } from "@/hives/workspace-root";
import fs from "fs";
import path from "path";

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

const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isPathSameOrInside(child: string, parent: string): boolean {
  return child === parent || isPathInside(child, parent);
}

function requireContainedWorkspace(candidatePath: string, allowedRoot: string): string {
  const resolvedRoot = path.resolve(allowedRoot);
  const resolvedCandidate = path.resolve(candidatePath);
  if (!isPathInside(resolvedCandidate, resolvedRoot)) {
    throw new Error("workspacePath must be inside the hive projects workspace root");
  }
  return resolvedCandidate;
}

function requireHiveProjectsRoot(hiveSlug: string): string {
  if (!PROJECT_SLUG_RE.test(hiveSlug)) {
    throw new Error("Invalid hive slug for workspace root");
  }

  const hiveProjectsRoot = hiveProjectsPath(hiveSlug);
  const resolvedRoot = resolveHiveWorkspaceRoot();
  const resolvedHiveProjectsRoot = path.resolve(hiveProjectsRoot);
  if (!isPathInside(resolvedHiveProjectsRoot, resolvedRoot)) {
    throw new Error("workspacePath root must be inside the hives workspace root");
  }

  return resolvedHiveProjectsRoot;
}

function nearestExistingParent(targetPath: string): string {
  let current = path.resolve(targetPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function verifyExistingParentNoSymlinkEscape(workspacePath: string, allowedRoot: string) {
  const realRoot = fs.realpathSync.native(path.resolve(allowedRoot));
  const parent = nearestExistingParent(workspacePath);
  const realParent = fs.realpathSync.native(parent);
  if (!isPathSameOrInside(realParent, realRoot)) {
    throw new Error("workspacePath parent resolves outside the hive projects workspace root");
  }
}

function verifyCreatedPathNoSymlinkEscape(workspacePath: string, allowedRoot: string) {
  const realRoot = fs.realpathSync.native(path.resolve(allowedRoot));
  const realWorkspace = fs.realpathSync.native(workspacePath);
  if (!isPathInside(realWorkspace, realRoot)) {
    throw new Error("workspacePath resolves outside the hive projects workspace root");
  }
}

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

export async function GET(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  try {
    const params = parseSearchParams(request.url);
    const hiveId = params.get("hiveId");
    const limit = params.getInt("limit", 50);
    const offset = params.getInt("offset", 0);

    if (!hiveId) {
      return jsonError("Missing required parameter: hiveId", 400);
    }
    if (!user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, user.id, hiveId);
      if (!hasAccess) {
        return jsonError("Forbidden: caller cannot access this hive", 403);
      }
    }

    const [countRow] = await sql`
      SELECT COUNT(*) as total FROM projects WHERE hive_id = ${hiveId}
    `;
    const total = parseInt((countRow as unknown as { total: string }).total, 10);

    const rows = await sql`
      SELECT id, hive_id, slug, name, workspace_path, git_repo, created_at, updated_at
      FROM projects
      WHERE hive_id = ${hiveId}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const data = (rows as unknown as ProjectRow[]).map(mapProjectRow);
    return jsonPaginated(data, total, limit, offset);
  } catch {
    return jsonError("Failed to fetch projects", 500);
  }
}

export async function POST(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  try {
    const body = await request.json();
    const { hiveId, slug, name, gitRepo, workspacePath: explicitWorkspacePath } = body;

    if (!hiveId || !slug || !name) {
      return jsonError("Missing required fields: hiveId, slug, name", 400);
    }
    if (!PROJECT_SLUG_RE.test(slug)) {
      return jsonError("Invalid project slug", 400);
    }

    if (!user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, user.id, hiveId);
      if (!hasAccess) {
        return jsonError("Forbidden: caller cannot access this hive", 403);
      }
      if (explicitWorkspacePath) {
        return jsonError("Forbidden: explicit workspacePath requires system owner", 403);
      }
    }

    // Get hive to derive the only allowed project workspace root.
    const [biz] = await sql`
      SELECT slug as biz_slug, workspace_path FROM hives WHERE id = ${hiveId}
    `;
    if (!biz) {
      return jsonError("Hive not found", 404);
    }

    const bizSlug = biz.biz_slug as string;
    const hiveProjectsRoot = requireHiveProjectsRoot(bizSlug);
    const workspacePath = requireContainedWorkspace(
      explicitWorkspacePath && user.isSystemOwner
        ? explicitWorkspacePath
        : path.join(hiveProjectsRoot, slug),
      hiveProjectsRoot,
    );

    verifyExistingParentNoSymlinkEscape(hiveProjectsRoot, resolveHiveWorkspaceRoot());
    fs.mkdirSync(hiveProjectsRoot, { recursive: true });
    verifyExistingParentNoSymlinkEscape(workspacePath, hiveProjectsRoot);
    fs.mkdirSync(workspacePath, { recursive: true });
    verifyCreatedPathNoSymlinkEscape(workspacePath, hiveProjectsRoot);

    const rows = await sql`
      INSERT INTO projects (hive_id, slug, name, workspace_path, git_repo)
      VALUES (${hiveId}, ${slug}, ${name}, ${workspacePath}, ${gitRepo ?? true})
      RETURNING id, hive_id, slug, name, workspace_path, git_repo, created_at, updated_at
    `;

    return jsonOk(mapProjectRow(rows[0] as unknown as ProjectRow), 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("workspacePath") || msg.includes("Invalid project slug") || msg.includes("Invalid hive slug")) {
      return jsonError(msg, 400);
    }
    if (msg.includes("projects_hive_slug_unique")) {
      return jsonError("A project with this slug already exists for this hive", 409);
    }
    return jsonError("Failed to create project", 500);
  }
}
