"use client";

import type { ProvisionStatus } from "../provisioning/types";

export function ProvisionBadge({ status }: { status: ProvisionStatus }) {
  if (status.satisfied) {
    return (
      <span title="Ready" className="inline-block w-2.5 h-2.5 rounded-full bg-green-500" />
    );
  }
  if (status.fixable) {
    return (
      <span title={status.reason ?? "Needs provisioning"} className="inline-block w-2.5 h-2.5 rounded-full bg-yellow-500" />
    );
  }
  return (
    <span title={status.reason ?? "Unavailable"} className="inline-block w-2.5 h-2.5 rounded-full bg-red-500" />
  );
}
