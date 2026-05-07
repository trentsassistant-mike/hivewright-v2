export interface RoleYaml {
  slug: string;
  name: string;
  department?: string;
  type: "system" | "executor";
  delegates_to: string[];
  recommended_model?: string;
  adapter_type: string;
  /**
   * When true, role-library sync always overwrites runtime routing fields
   * from role.yaml. Use this for roles where a stale dashboard override would
   * route work to the wrong adapter or model.
   */
  lock_runtime_config?: boolean;
  skills: string[];
  /**
   * Marks the role as inherently terminal — completions don't imply
   * follow-up work. The Hive Supervisor's unsatisfied_completion and
   * orphan_output detectors suppress terminal roles to prevent
   * self-referential false positives on watchdogs / system roles /
   * analysis-only executors. Defaults to false when omitted.
   */
  terminal?: boolean;
}

export interface RoleTemplate extends RoleYaml {
  roleMd: string | null;
  soulMd: string | null;
  toolsMd: string | null;
}
