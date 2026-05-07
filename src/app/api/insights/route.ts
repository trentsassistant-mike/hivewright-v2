import { NextRequest } from "next/server";
import { canAccessHive } from "@/auth/users";
import { sql } from "@/app/api/_lib/db";
import { jsonOk, jsonError, parseSearchParams } from "@/app/api/_lib/responses";
import { requireApiUser } from "@/app/api/_lib/auth";

type InsightRow = {
  id: string;
  hive_id: string;
  hive_name: string;
  content: string;
  connection_type: string;
  affected_departments: string[];
  confidence: number;
  priority: string;
  status: string;
  curator_reason: string | null;
  curated_at: Date | null;
  decision_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export async function GET(req: NextRequest) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  try {
    const params = parseSearchParams(req.url);
    const hiveId = params.get("hiveId");
    const status = params.get("status") ?? "new";
    if (hiveId && !user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, user.id, hiveId);
      if (!hasAccess) {
        return jsonError("Forbidden: caller cannot access this hive", 403);
      }
    }

    let rows: InsightRow[];
    if (hiveId) {
      rows = await sql<InsightRow[]>`
          SELECT
            i.id::text AS id,
            i.hive_id::text AS hive_id,
            b.name AS hive_name,
            i.content,
            i.connection_type,
            i.affected_departments,
            i.confidence,
            i.priority,
            i.status,
            i.curator_reason,
            i.curated_at,
            i.decision_id::text AS decision_id,
            i.created_at,
            i.updated_at
          FROM insights i
          JOIN hives b ON b.id = i.hive_id
          WHERE i.hive_id = ${hiveId}::uuid
            AND i.status = ${status}
          ORDER BY i.confidence DESC, i.created_at DESC
        `;
    } else if (!user.isSystemOwner) {
      rows = await sql<InsightRow[]>`
          SELECT
            i.id::text AS id,
            i.hive_id::text AS hive_id,
            b.name AS hive_name,
            i.content,
            i.connection_type,
            i.affected_departments,
            i.confidence,
            i.priority,
            i.status,
            i.curator_reason,
            i.curated_at,
            i.decision_id::text AS decision_id,
            i.created_at,
            i.updated_at
          FROM insights i
          JOIN hives b ON b.id = i.hive_id
          WHERE i.hive_id IN (
              SELECT hive_id FROM hive_memberships WHERE user_id = ${user.id}
            )
            AND i.status = ${status}
          ORDER BY i.confidence DESC, i.created_at DESC
        `;
    } else {
      rows = await sql<InsightRow[]>`
          SELECT
            i.id::text AS id,
            i.hive_id::text AS hive_id,
            b.name AS hive_name,
            i.content,
            i.connection_type,
            i.affected_departments,
            i.confidence,
            i.priority,
            i.status,
            i.curator_reason,
            i.curated_at,
            i.decision_id::text AS decision_id,
            i.created_at,
            i.updated_at
          FROM insights i
          JOIN hives b ON b.id = i.hive_id
          WHERE i.status = ${status}
          ORDER BY i.confidence DESC, i.created_at DESC
        `;
    }

    return jsonOk(rows);
  } catch (err) {
    console.error("[insights GET]", err);
    return jsonError("Failed to fetch insights", 500);
  }
}
