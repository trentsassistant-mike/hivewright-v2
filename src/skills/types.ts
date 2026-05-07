export interface LoadedSkill {
  slug: string;
  content: string;
  /** "system" = from skills-library/, "hive" = from hive skills dir */
  tier: "system" | "hive";
}

export interface SkillDraft {
  id: string;
  hiveId: string;
  roleSlug: string;
  targetRoleSlugs: string[];
  sourceTaskId: string | null;
  originatingTaskId: string | null;
  originatingFeedbackId: string | null;
  slug: string;
  content: string;
  scope: "system" | "hive";
  sourceType: "internal" | "external";
  provenanceUrl: string | null;
  internalSourceRef: string | null;
  licenseNotes: string | null;
  securityReviewStatus: "pending" | "approved" | "rejected" | "not_required";
  qaReviewStatus: "pending" | "approved" | "rejected" | "not_required";
  evidence: Record<string, unknown>[];
  status: "pending" | "reviewing" | "approved" | "rejected" | "published" | "archived";
  feedback: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  publishedBy: string | null;
  publishedAt: Date | null;
  archivedBy: string | null;
  archivedAt: Date | null;
  archiveReason: string | null;
  adoptionEvidence: Record<string, unknown>[];
  createdAt: Date;
  updatedAt: Date;
}
