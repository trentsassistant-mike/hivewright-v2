import type { Sql } from "postgres";

/**
 * Resolve the GPU voice-services base URL.
 *
 * Source of truth (post-Phase-A) is the per-hive `voice-ea` connector
 * install. The owner edits this in the dashboard's Connectors page, no
 * env reload needed. `VOICE_SERVICES_URL` env stays as a fallback for
 * tests and fresh dev boxes that don't have a connector install yet.
 *
 * Returns `null` when neither source has a value so callers can surface
 * a clear "voice EA not configured" error rather than crashing on a
 * malformed fetch.
 */
export async function loadVoiceServicesUrl(
  sql: Sql,
  hiveId: string,
): Promise<string | null> {
  const [row] = await sql<{ config: unknown }[]>`
    SELECT config FROM connector_installs
    WHERE hive_id = ${hiveId}
      AND connector_slug = 'voice-ea'
      AND status = 'active'
    LIMIT 1
  `;
  const cfg = (row?.config as Record<string, unknown> | null | undefined) ?? null;
  const fromConnector = typeof cfg?.voiceServicesUrl === "string"
    ? cfg.voiceServicesUrl
    : null;
  const url = fromConnector ?? process.env.VOICE_SERVICES_URL ?? null;
  if (!url || url.length === 0) return null;
  return url.replace(/\/$/, "");
}

/**
 * Sync env-only fallback. Used by the dispatcher's WS handler at upgrade
 * time when we don't have a hive id yet (the token carries it but auth
 * runs before the DB lookup). Falls back gracefully to the per-hive
 * loader once the runtime has resolved the hive.
 */
export function getVoiceServicesUrlFromEnv(): string | null {
  const url = process.env.VOICE_SERVICES_URL;
  if (typeof url !== "string" || url.length === 0) return null;
  return url.replace(/\/$/, "");
}
