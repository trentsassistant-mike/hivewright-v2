import fs from "fs";
import path from "path";
import { sql } from "../_lib/db";
import { jsonOk, jsonError } from "../_lib/responses";
import { requireApiUser } from "../_lib/auth";
import { seedDefaultSchedules } from "@/hives/seed-schedules";
import { hiveProjectsPath } from "@/hives/workspace-root";

const HIVE_SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,63}$/;

export async function GET(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  try {
    const includeSystemFixtures =
      new URL(request.url).searchParams.get("includeSystemFixtures") === "true";
    const rows = authz.user.isSystemOwner
      ? includeSystemFixtures
        ? await sql`
        SELECT id, slug, name, type, description, workspace_path, is_system_fixture, created_at
        FROM hives ORDER BY name ASC
      `
        : await sql`
        SELECT id, slug, name, type, description, workspace_path, is_system_fixture, created_at
        FROM hives
        WHERE is_system_fixture = false
        ORDER BY name ASC
      `
      : includeSystemFixtures
        ? await sql`
        SELECT h.id, h.slug, h.name, h.type, h.description, h.workspace_path, h.is_system_fixture, h.created_at
        FROM hives h
        INNER JOIN hive_memberships hm ON hm.hive_id = h.id
        WHERE hm.user_id = ${authz.user.id}
        ORDER BY h.name ASC
      `
        : await sql`
        SELECT h.id, h.slug, h.name, h.type, h.description, h.workspace_path, h.is_system_fixture, h.created_at
        FROM hives h
        INNER JOIN hive_memberships hm ON hm.hive_id = h.id
        WHERE hm.user_id = ${authz.user.id}
          AND h.is_system_fixture = false
        ORDER BY h.name ASC
      `;
    const data = rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      type: r.type,
      description: r.description,
      workspacePath: r.workspace_path,
      isSystemFixture: r.is_system_fixture,
      createdAt: r.created_at,
    }));
    return jsonOk(data);
  } catch {
    return jsonError("Failed to fetch hives", 500);
  }
}

export async function POST(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  if (!authz.user.isSystemOwner) {
    return jsonError("Forbidden: system owner role required", 403);
  }
  try {
    const body = await request.json();
    const { name, slug, type, description, mission } = body;
    if (!name || !slug || !type) return jsonError("name, slug, and type are required", 400);
    if (typeof slug !== "string" || !HIVE_SLUG_REGEX.test(slug)) {
      return jsonError("slug must match ^[a-z0-9][a-z0-9-]{1,63}$", 400);
    }
    const workspacePath = hiveProjectsPath(slug);
    const [row] = await sql`
      INSERT INTO hives (name, slug, type, description, mission, workspace_path)
      VALUES (${name}, ${slug}, ${type}, ${description || null}, ${mission || null}, ${workspacePath})
      RETURNING *
    `;

    // Create hive workspace directory structure
    const bizRoot = path.dirname(workspacePath);
    for (const dir of ["projects", "skills", "ea"]) {
      fs.mkdirSync(path.join(bizRoot, dir), { recursive: true });
    }

    // Seed the built-in daily world-scan schedule. Non-fatal — a scheduling
    // hiccup shouldn't prevent hive creation.
    try {
      await seedDefaultSchedules(sql, {
        id: row.id as string,
        name: row.name as string,
        description: (row.description as string | null) ?? null,
      });
    } catch (err) {
      console.warn("[api/hives POST] failed to seed default schedules:", err);
    }

    return jsonOk({ id: row.id, name: row.name, slug: row.slug, type: row.type }, 201);
  } catch {
    return jsonError("Failed to create hive", 500);
  }
}
