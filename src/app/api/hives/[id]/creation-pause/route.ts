import { sql } from "@/app/api/_lib/db";
import { requireSystemOwner } from "@/app/api/_lib/auth";
import { jsonError, jsonOk } from "@/app/api/_lib/responses";
import { getHiveCreationPause } from "@/operations/creation-pause";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RuntimeLockRow = {
  creation_paused: boolean;
  operating_state: string | null;
  schedule_snapshot: unknown;
};

function scheduleSnapshotFrom(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string" && UUID_RE.test(id))
    : [];
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;

  const { id } = await params;
  if (!UUID_RE.test(id)) return jsonError("id must be a valid UUID", 400);

  const [hive] = await sql`SELECT 1 FROM hives WHERE id = ${id} LIMIT 1`;
  if (!hive) return jsonError("hive not found", 404);

  return jsonOk(await getHiveCreationPause(sql, id));
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;

  const { id } = await params;
  if (!UUID_RE.test(id)) return jsonError("id must be a valid UUID", 400);

  let body: { paused?: unknown; reason?: unknown };
  try {
    body = await request.json() as { paused?: unknown; reason?: unknown };
  } catch {
    return jsonError("invalid JSON", 400);
  }

  if (typeof body.paused !== "boolean") {
    return jsonError("paused must be a boolean", 400);
  }

  const paused = body.paused;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (paused && reason.length === 0) {
    return jsonError("reason is required when pausing creation", 400);
  }
  if (reason.length > 500) return jsonError("reason is too long", 400);

  const [hive] = await sql`SELECT 1 FROM hives WHERE id = ${id} LIMIT 1`;
  if (!hive) return jsonError("hive not found", 404);

  await sql.begin(async (tx) => {
    const [current] = await tx<RuntimeLockRow[]>`
      SELECT creation_paused, operating_state, schedule_snapshot
      FROM hive_runtime_locks
      WHERE hive_id = ${id}::uuid
      FOR UPDATE
    `;

    const previousState =
      current?.operating_state ?? (current?.creation_paused ? "paused" : "normal");
    let scheduleSnapshot = scheduleSnapshotFrom(current?.schedule_snapshot);

    if (paused) {
      if (!current?.creation_paused) {
        const enabledSchedules = await tx<{ id: string }[]>`
          SELECT id
          FROM schedules
          WHERE hive_id = ${id}::uuid
            AND enabled = true
          ORDER BY id
        `;
        scheduleSnapshot = enabledSchedules.map((schedule) => schedule.id);
      }

      await tx`
        UPDATE schedules
        SET enabled = false
        WHERE hive_id = ${id}::uuid
          AND enabled = true
      `;
    } else if (scheduleSnapshot.length > 0) {
      await tx`
        UPDATE schedules
        SET enabled = true
        WHERE hive_id = ${id}::uuid
          AND id = ANY(${scheduleSnapshot}::uuid[])
      `;
    }

    const nextState = paused ? "paused" : "normal";
    const nextSnapshot = paused ? scheduleSnapshot : [];

    await tx`
      INSERT INTO hive_runtime_locks (
        hive_id,
        creation_paused,
        reason,
        paused_by,
        updated_at,
        operating_state,
        schedule_snapshot
      )
      VALUES (
        ${id},
        ${paused},
        ${paused ? reason : null},
        ${authz.user.email},
        NOW(),
        ${nextState},
        ${JSON.stringify(nextSnapshot)}::jsonb
      )
      ON CONFLICT (hive_id)
      DO UPDATE SET
        creation_paused = EXCLUDED.creation_paused,
        reason = EXCLUDED.reason,
        paused_by = EXCLUDED.paused_by,
        updated_at = NOW(),
        operating_state = EXCLUDED.operating_state,
        schedule_snapshot = EXCLUDED.schedule_snapshot
    `;

    await tx`
      INSERT INTO hive_runtime_lock_events (
        hive_id,
        previous_state,
        next_state,
        creation_paused,
        reason,
        changed_by,
        schedule_snapshot
      )
      VALUES (
        ${id},
        ${previousState},
        ${nextState},
        ${paused},
        ${paused ? reason : null},
        ${authz.user.email},
        ${JSON.stringify(nextSnapshot)}::jsonb
      )
    `;
  });

  return jsonOk(await getHiveCreationPause(sql, id));
}
