import type { Sql } from "postgres";

export interface NormalizedCodexEmptyOutputDiagnostic {
  codexEmptyOutput: true;
  rolloutSignaturePresent: boolean;
  exitCode: number | null;
  effectiveAdapter: string | null;
  adapterOverride: string | null;
  modelSlug: string;
  modelProviderMismatchDetected: boolean;
  cwd: string;
  stderrTail: string;
  truncated: boolean;
}

export function normalizeCodexEmptyOutputDiagnostic(
  value: unknown,
): NormalizedCodexEmptyOutputDiagnostic | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (source.kind !== "codex_empty_output" || source.codexEmptyOutput !== true) {
    return null;
  }

  const exitCode = typeof source.exitCode === "number" ? source.exitCode : null;
  return {
    codexEmptyOutput: true,
    rolloutSignaturePresent: source.rolloutSignaturePresent === true,
    exitCode,
    effectiveAdapter: typeof source.effectiveAdapter === "string" ? source.effectiveAdapter : null,
    adapterOverride: typeof source.adapterOverride === "string" ? source.adapterOverride : null,
    modelSlug: typeof source.modelSlug === "string" ? source.modelSlug : "",
    modelProviderMismatchDetected: source.modelProviderMismatchDetected === true,
    cwd: typeof source.cwd === "string" ? source.cwd : "",
    stderrTail: typeof source.stderrTail === "string" ? source.stderrTail : "",
    truncated: source.truncated === true,
  };
}

export async function readLatestCodexEmptyOutputDiagnostic(
  sql: Sql,
  taskId: string,
): Promise<NormalizedCodexEmptyOutputDiagnostic | null> {
  const [row] = await sql<{ chunk: unknown }[]>`
    SELECT chunk
    FROM task_logs
    WHERE task_id = ${taskId}
      AND type = 'diagnostic'
      AND chunk::jsonb ->> 'kind' = 'codex_empty_output'
    ORDER BY id DESC
    LIMIT 1
  `;
  if (!row) return null;

  const chunk = row.chunk;
  if (typeof chunk === "string") {
    try {
      return normalizeCodexEmptyOutputDiagnostic(JSON.parse(chunk));
    } catch {
      return null;
    }
  }
  return normalizeCodexEmptyOutputDiagnostic(chunk);
}
