import type { Sql } from "postgres";
import { NextResponse } from "next/server";

export type HiveCreationPause = {
  paused: boolean;
  reason: string | null;
  pausedBy: string | null;
  updatedAt: string | null;
  operatingState: "normal" | "paused" | "recovery" | "degraded";
  pausedScheduleIds: string[];
};

type HiveCreationPauseRow = {
  paused: boolean;
  reason: string | null;
  paused_by: string | null;
  updated_at: Date | string | null;
  operating_state: string | null;
  schedule_snapshot: unknown;
};

type RuntimeLockRow = {
  creation_paused: boolean;
  operating_state: string | null;
  schedule_snapshot: unknown;
};

export const CREATION_PAUSE_ERROR = "Hive creation is paused";

export async function getHiveCreationPause(
  db: Sql,
  hiveId: string,
): Promise<HiveCreationPause> {
  const [row] = await db<HiveCreationPauseRow[]>`
    SELECT
      creation_paused AS paused,
      reason,
      paused_by,
      updated_at,
      operating_state,
      schedule_snapshot
    FROM hive_runtime_locks
    WHERE hive_id = ${hiveId}::uuid
    LIMIT 1
  `;

  if (!row) {
    return {
      paused: false,
      reason: null,
      pausedBy: null,
      updatedAt: null,
      operatingState: "normal",
      pausedScheduleIds: [],
    };
  }

  const pausedScheduleIds = Array.isArray(row.schedule_snapshot)
    ? row.schedule_snapshot.filter((id): id is string => typeof id === "string")
    : [];
  const operatingState =
    row.operating_state === "paused" ||
    row.operating_state === "recovery" ||
    row.operating_state === "degraded"
      ? row.operating_state
      : "normal";

  return {
    paused: Boolean(row.paused),
    reason: row.reason ?? null,
    pausedBy: row.paused_by ?? null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    operatingState,
    pausedScheduleIds,
  };
}

export async function assertHiveCreationAllowed(
  db: Sql,
  hiveId: string,
): Promise<HiveCreationPause | null> {
  const pause = await getHiveCreationPause(db, hiveId);
  return pause.paused ? pause : null;
}

export function creationPausedResponse(pause: HiveCreationPause): NextResponse {
  const suffix = pause.reason ? `: ${pause.reason}` : "";
  return NextResponse.json(
    {
      error: `${CREATION_PAUSE_ERROR}${suffix}`,
      code: "HIVE_CREATION_PAUSED",
      creationPause: pause,
    },
    { status: 423 },
  );
}

export function databaseCreationPaused(reason = "Creation was blocked by the database guard."): HiveCreationPause {
  return {
    paused: true,
    reason,
    pausedBy: null,
    updatedAt: null,
    operatingState: "paused",
    pausedScheduleIds: [],
  };
}

export function isCreationPauseDbError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("HIVE_CREATION_PAUSED");
}

function scheduleSnapshotFrom(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string")
    : [];
}

export async function setHiveCreationPause(
  db: Sql,
  input: {
    hiveId: string;
    paused: boolean;
    reason?: string | null;
    changedBy?: string | null;
  },
): Promise<HiveCreationPause> {
  await db.begin(async (tx) => {
    const [current] = await tx<RuntimeLockRow[]>`
      SELECT creation_paused, operating_state, schedule_snapshot
      FROM hive_runtime_locks
      WHERE hive_id = ${input.hiveId}::uuid
      FOR UPDATE
    `;

    const previousState =
      current?.operating_state ?? (current?.creation_paused ? "paused" : "normal");
    let scheduleSnapshot = scheduleSnapshotFrom(current?.schedule_snapshot);

    if (input.paused) {
      if (!current?.creation_paused) {
        const enabledSchedules = await tx<{ id: string }[]>`
          SELECT id
          FROM schedules
          WHERE hive_id = ${input.hiveId}::uuid
            AND enabled = true
          ORDER BY id
        `;
        scheduleSnapshot = enabledSchedules.map((schedule) => schedule.id);
      }

      await tx`
        UPDATE schedules
        SET enabled = false
        WHERE hive_id = ${input.hiveId}::uuid
          AND enabled = true
      `;
    } else if (scheduleSnapshot.length > 0) {
      await tx`
        UPDATE schedules
        SET enabled = true
        WHERE hive_id = ${input.hiveId}::uuid
          AND id = ANY(${scheduleSnapshot}::uuid[])
      `;
    }

    const nextState = input.paused ? "paused" : "normal";
    const nextSnapshot = input.paused ? scheduleSnapshot : [];

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
        ${input.hiveId},
        ${input.paused},
        ${input.paused ? input.reason ?? null : null},
        ${input.changedBy ?? null},
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
        ${input.hiveId},
        ${previousState},
        ${nextState},
        ${input.paused},
        ${input.paused ? input.reason ?? null : null},
        ${input.changedBy ?? null},
        ${JSON.stringify(nextSnapshot)}::jsonb
      )
    `;
  });

  return getHiveCreationPause(db, input.hiveId);
}
