export interface ProvisionStatus {
  /** True when the adapter is ready to spawn this role without side-effects. */
  satisfied: boolean;
  /** Human-readable explanation when not satisfied. Omitted when satisfied. */
  reason?: string;
  /** True when calling provision() would (likely) make it satisfied. */
  fixable: boolean;
}

export type ProvisionProgress =
  | { phase: "checking"; message: string }
  | { phase: "pulling"; message: string; percentComplete?: number }
  | { phase: "installing"; message: string }
  | { phase: "done"; status: ProvisionStatus };

export interface ProvisionerInput {
  slug: string;
  recommendedModel: string;
}

export interface Provisioner {
  check(input: ProvisionerInput): Promise<ProvisionStatus>;
  provision(input: ProvisionerInput): AsyncIterable<ProvisionProgress>;
}
