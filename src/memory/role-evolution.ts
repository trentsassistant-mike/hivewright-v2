import type { Sql } from "postgres";

export interface RoleEvolutionCandidate {
  roleSlug: string;
  hiveId: string;
  pattern: string;
  occurrences: number;
}

/**
 * Find role memory entries that appear frequently (3+ times with similar content)
 * and haven't been promoted to role template updates yet.
 */
export async function findEvolutionCandidates(
  sql: Sql,
  hiveId: string,
): Promise<RoleEvolutionCandidate[]> {
  // Find role memories with high access_count (indicates repeated relevance)
  // and similar content patterns
  const candidates = await sql`
    SELECT role_slug, content, access_count
    FROM role_memory
    WHERE hive_id = ${hiveId}
      AND superseded_by IS NULL
      AND access_count >= 3
      AND confidence >= 0.8
    ORDER BY access_count DESC
    LIMIT 20
  `;

  return candidates.map(r => ({
    roleSlug: r.role_slug as string,
    hiveId,
    pattern: r.content as string,
    occurrences: r.access_count as number,
  }));
}

/**
 * Promote a learned role-memory pattern. Tier 2 (auto-applied, flagged).
 *
 * Rather than blocking the owner with a "please approve", we bump the
 * source memory entry's confidence to 1.0 and annotate the content with a
 * `[promoted]` marker so the injection pipeline treats it as a first-class
 * fact. A record of the change lands in `decisions` with
 * status = 'auto_approved' so the owner can audit or reverse it from the
 * Decisions page — but it doesn't sit in the "Needs your input" queue.
 *
 * Dedupes against both pending and auto_approved proposals so the same
 * pattern isn't promoted twice in a row.
 */
export async function proposeRoleUpdate(
  sql: Sql,
  candidate: RoleEvolutionCandidate,
): Promise<string> {
  // Skip if a decision already exists (pending OR auto_approved).
  const [existing] = await sql`
    SELECT id FROM decisions
    WHERE hive_id = ${candidate.hiveId}
      AND LOWER(title) LIKE ${'%' + candidate.roleSlug.toLowerCase() + '%'}
      AND LOWER(title) LIKE '%role update%'
      AND status IN ('pending', 'auto_approved')
  `;
  if (existing) return existing.id as string;

  // Autonomous action: bump confidence on the matching role_memory row so
  // agents treat the pattern as settled. We match on content prefix because
  // the candidate pattern string comes directly from role_memory.content.
  await sql`
    UPDATE role_memory
    SET confidence = 1.0,
        updated_at = NOW()
    WHERE hive_id = ${candidate.hiveId}
      AND role_slug = ${candidate.roleSlug}
      AND content = ${candidate.pattern}
      AND superseded_by IS NULL
  `;

  const [decision] = await sql`
    INSERT INTO decisions (hive_id, title, context, recommendation, priority, status)
    VALUES (
      ${candidate.hiveId},
      ${'Role update applied: ' + candidate.roleSlug},
      ${'The ' + candidate.roleSlug + ' role has learned a recurring pattern (accessed ' + candidate.occurrences + '+ times):\n\n"' + candidate.pattern + '"\n\nAuto-promoted: confidence raised to 1.0 on the source memory entry so the injection pipeline now treats it as a settled fact. No owner action needed unless you disagree.'},
      'Reject to roll the confidence back to what it was. Approve (no-op) to confirm.',
      'normal',
      'auto_approved'
    )
    RETURNING id
  `;

  return decision.id as string;
}
