/**
 * Classify an escalation's failure reason into "decision" (something the
 * owner should actually weigh in on) vs "system_error" (an infrastructure
 * failure that only code can fix). The dispatcher's escalation paths use
 * this to decide whether a Tier 3 row should page the owner or sit in
 * the System Health queue for a dev to pick up.
 *
 * Default is 'decision' — only route to 'system_error' when the pattern
 * is unambiguously infrastructure. False negatives here just mean an
 * infra issue lands in the owner queue (current status quo); false
 * positives would *hide* a genuine decision from the owner, which is
 * worse. So the patterns below are tight.
 */
export type DecisionKind = "decision" | "system_error";

const INFRASTRUCTURE_PATTERNS: readonly RegExp[] = [
  // Codex / TOML config parse failures (the fc16f0b leak pattern).
  /Error loading config\.toml/i,
  /invalid type:\s*string/i,
  // Process spawn failures — binary missing, not executable, wrong PATH.
  /\bENOENT\b/,
  /\bEACCES\b/,
  /\bspawn\s+\S+\s+ENOENT\b/i,
  /command not found/i,
  /Cannot find module/i,
  // Env / secrets plumbing failures.
  /Missing env var/i,
  /SecretRefResolutionError/i,
  /SECRETS_RELOADER_DEGRADED/,
  // Network / DB connectivity.
  /\bECONNREFUSED\b/,
  /\bETIMEDOUT\b/,
  /connection to server at .* failed/i,
  // Docker / subprocess resource failures.
  /\bEMFILE\b/,
  /\bENOSPC\b/,
  // Generic "process exited with code N" with no other signal = infra
  // noise; but only when paired with one of the specific markers above,
  // so it's not listed here on its own (would hide legit failures).
];

export function classifyFailureReason(reason: string | null | undefined): DecisionKind {
  if (!reason) return "decision";
  for (const pattern of INFRASTRUCTURE_PATTERNS) {
    if (pattern.test(reason)) return "system_error";
  }
  return "decision";
}
