// `created_by` on hive_ideas is a session-derived role slug — never trusted
// from the request body. The value is one of:
//   "owner"              — human hive owner captured the idea via the
//                          dashboard (privileged session, no system-role
//                          header).
//   "ea"                 — native Executive Assistant captured the idea for
//                          the owner (Sprint 2). Caller is a privileged
//                          session AND sends `X-System-Role: ea`.
//   <role slug>          — supervisor / automated agent captured the idea
//                          (e.g. "ideas-curator" for the Sprint 3 daily
//                          review job). Caller is a privileged session AND
//                          sends `X-System-Role: <slug>`.
//   "system"             — any other authenticated caller (hive member
//                          without system-owner privilege). Attribution is
//                          forced to "system" so role authorship cannot be
//                          spoofed from a hive-member session.
//
// Role-slug pattern mirrors role_templates.slug: lowercase, starts with a
// letter, digits and hyphens allowed. 50-char cap matches the
// `hive_ideas.created_by` column (varchar(50)).
const ROLE_SLUG = /^[a-z][a-z0-9-]*$/;
const MAX_LEN = 50;

export function isValidRoleSlug(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length > 0 &&
    v.length <= MAX_LEN &&
    ROLE_SLUG.test(v)
  );
}

// Back-compat alias retained for any callers still importing the old name.
export const isValidCreatedBy = isValidRoleSlug;

// Trusted seam the EA (Sprint 2) and daily-review agent (Sprint 3) use to
// identify themselves. Returning "INVALID" lets callers 400 on malformed
// values without silently falling back to the default slug. `null` means the
// header was absent or blank — the default path (owner/system).
export type SystemRoleHeader = string | null | "INVALID";

export function readSystemRoleHeader(request: Request): SystemRoleHeader {
  const raw = request.headers.get("x-system-role");
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return isValidRoleSlug(trimmed) ? trimmed : "INVALID";
}

// Session-path identity used to compute created_by and to gate
// system-only fields like ai_assessment. The header is only honored when
// paired with a privileged (system-owner) session so a hive-member session
// can never forge an agent attribution.
export interface SessionPath {
  isSystemOwner: boolean;
  systemRole: string | null;
}

export function sessionPathFrom(
  user: { isSystemOwner: boolean },
  header: SystemRoleHeader,
): SessionPath {
  const trustedHeader = header !== null && header !== "INVALID" ? header : null;
  return {
    isSystemOwner: user.isSystemOwner,
    systemRole: user.isSystemOwner ? trustedHeader : null,
  };
}

export function resolveCreatedBy(path: SessionPath): string {
  if (path.isSystemOwner) {
    return path.systemRole ?? "owner";
  }
  return "system";
}

// Distinct "system path" predicate. Writes to ai_assessment require the
// caller to identify as an automated agent (system-owner session PLUS a
// system-role header). The human owner's dashboard session is NOT on the
// system path — ai_assessment is a machine-only field populated by the
// daily-review agent.
export function isSystemPath(path: SessionPath): boolean {
  return path.isSystemOwner && path.systemRole !== null;
}
