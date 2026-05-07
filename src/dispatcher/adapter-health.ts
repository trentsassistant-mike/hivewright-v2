import type { Sql } from "postgres";
import { provisionerFor as defaultProvisionerFor } from "@/provisioning";
import type { Provisioner } from "@/provisioning/types";
import { checkModelSpawnHealth, type ModelSpawnHealthDecision } from "@/model-health/spawn-gate";

export type DispatcherModelRouteHealthReason =
  | "model_health_and_provisioner_healthy"
  | "provisioner_missing"
  | "provisioner_unhealthy"
  | ModelSpawnHealthDecision["reason"];

export interface DispatcherModelRouteHealthInput {
  hiveId: string;
  roleSlug: string;
  adapterType: string;
  modelId: string;
  now?: Date;
  provisionerFor?: (adapterType: string) => Provisioner | null;
}

export interface DispatcherModelRouteHealthDecision {
  healthy: boolean;
  reason: DispatcherModelRouteHealthReason;
  detail?: string;
  modelHealth: ModelSpawnHealthDecision;
}

export async function checkDispatcherModelRouteHealth(
  sql: Sql,
  input: DispatcherModelRouteHealthInput,
): Promise<DispatcherModelRouteHealthDecision> {
  const modelHealth = await checkModelSpawnHealth(sql, {
    hiveId: input.hiveId,
    adapterType: input.adapterType,
    modelId: input.modelId,
    now: input.now,
  });

  if (!modelHealth.canRun) {
    return {
      healthy: false,
      reason: modelHealth.reason,
      detail: modelHealth.failureReason ?? undefined,
      modelHealth,
    };
  }

  const provisionerFor = input.provisionerFor ?? defaultProvisionerFor;
  const provisioner = provisionerFor(input.adapterType);
  if (!provisioner) {
    return {
      healthy: false,
      reason: "provisioner_missing",
      detail: `No provisioner registered for adapter ${input.adapterType}`,
      modelHealth,
    };
  }

  const provision = await provisioner.check({
    slug: input.roleSlug,
    recommendedModel: input.modelId,
  });
  if (!provision.satisfied) {
    return {
      healthy: false,
      reason: "provisioner_unhealthy",
      detail: provision.reason,
      modelHealth,
    };
  }

  return {
    healthy: true,
    reason: "model_health_and_provisioner_healthy",
    modelHealth,
  };
}
