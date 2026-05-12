import { sql as appSql } from "../_lib/db";
import { jsonOk, jsonError } from "../_lib/responses";
import { enforceInternalTaskHiveScope, isInternalServiceAccountUser, requireApiUser } from "../_lib/auth";
import { canAccessHive } from "@/auth/users";
import { validateAttachmentFiles } from "@/attachments/constants";
import { maybeRecordEaHiveSwitch } from "@/ea/native/hive-switch-audit";
import { DefaultProjectResolutionError } from "@/projects/default-project";
import {
  assertHiveCreationAllowed,
  creationPausedResponse,
  databaseCreationPaused,
  isCreationPauseDbError,
} from "@/operations/creation-pause";
import { submitWorkIntake, WorkIntakeValidationError } from "./submit-work-intake";

// Per-handler authorization (audit 2026-04-22 task-area pass).
// Work intake can insert into `tasks` and set `created_by` on the resulting
// row. Previously any authenticated session could target any hive and the
// task path hardcoded `created_by='owner'`, which let a non-owner caller
// launder work into another hive and forge owner-level attribution.
// Minimum hardening applied here:
//   1. Resolve the caller via `requireApiUser()` (not just session presence).
//   2. Enforce `canAccessHive()` on the supplied hiveId before any classifier
//      run or insert. System owners bypass membership via the helper itself.
//   3. Derive `created_by` from the session instead of hardcoding 'owner'.
// Role-slug attribution for non-owner supervisors remains blocked until role
// propagation lands in the JWT — see residual-risk note in the audit doc at
// `docs/security/2026-04-22-goal-task-mutation-auth-seams.md`.
export async function POST(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  try {
    const contentType = request.headers.get("content-type") ?? "";
    const isMultipart = contentType.includes("multipart/form-data");

    let hiveId: string;
    let input: string;
    let assignedTo: string | undefined;
    let projectId: string | undefined;
    let goalId: string | undefined;
    let sprintNumber: number | undefined;
    let qaRequired: boolean | undefined;
    let priority: number | undefined;
    let acceptanceCriteria: string | undefined;
    let forceType: "goal" | undefined;
    let requestedCreatedBy: string | undefined;
    let files: File[] = [];

    if (isMultipart) {
      const formData = await request.formData();
      hiveId = (formData.get("hiveId") as string) ?? "";
      input = (formData.get("input") as string) ?? "";
      assignedTo = (formData.get("assignedTo") as string) || undefined;
      projectId = ((formData.get("projectId") as string) || (formData.get("project_id") as string)) || undefined;
      goalId = (formData.get("goalId") as string) || undefined;
      const sprintNumberRaw = formData.get("sprintNumber");
      sprintNumber = typeof sprintNumberRaw === "string" && sprintNumberRaw.trim() !== ""
        ? Number(sprintNumberRaw)
        : undefined;
      qaRequired = formData.get("qaRequired") === "true";
      const priorityRaw = formData.get("priority");
      priority = typeof priorityRaw === "string" && priorityRaw.trim() !== ""
        ? Number(priorityRaw)
        : undefined;
      acceptanceCriteria = (formData.get("acceptanceCriteria") as string) || undefined;
      forceType = formData.get("forceType") === "goal" ? "goal" : undefined;
      requestedCreatedBy = (formData.get("createdBy") as string) || undefined;
      files = formData.getAll("files") as File[];
      const validationError = validateAttachmentFiles(files);
      if (validationError) return jsonError(validationError, 400);
    } else {
      const body = await request.json();
      ({ hiveId, input, assignedTo, projectId, goalId, sprintNumber, qaRequired, priority, acceptanceCriteria } = body);
      projectId = projectId ?? body.project_id;
      forceType = body.forceType === "goal" ? "goal" : undefined;
      requestedCreatedBy = typeof body.createdBy === "string" ? body.createdBy : undefined;
    }

    if (!hiveId || !input) return jsonError("Missing required fields: hiveId, input", 400);

    const taskScope = await enforceInternalTaskHiveScope(hiveId);
    if (!taskScope.ok) return taskScope.response;

    const creationPause = await assertHiveCreationAllowed(appSql, hiveId);
    if (creationPause) return creationPausedResponse(creationPause);

    if (!user.isSystemOwner) {
      const hasAccess = await canAccessHive(appSql, user.id, hiveId);
      if (!hasAccess) return jsonError("Forbidden: caller cannot access this hive", 403);
    }

    // tasks.created_by stores role slugs ("owner", "ea", "system", role
    // templates), not user ids — see the note in
    // src/app/api/attachments/[id]/download/route.ts. Until role propagation
    // lands, the only honest session-derived slug is "owner" for system
    // owners and "system" for any other in-scope caller.
    const createdBy = isInternalServiceAccountUser(user) && requestedCreatedBy === "initiative-engine"
      ? "initiative-engine"
      : user.isSystemOwner
        ? "owner"
        : "system";

    const data = await submitWorkIntake({
      hiveId,
      input,
      assignedTo,
      projectId,
      goalId,
      sprintNumber,
      qaRequired,
      priority,
      acceptanceCriteria,
      files,
      createdBy,
      forceType,
    });
    await maybeRecordEaHiveSwitch(appSql, request, hiveId, {
      type: data.type,
      id: data.id,
    });
    return jsonOk(data, 201);
  } catch (error) {
    if (isCreationPauseDbError(error)) {
      return creationPausedResponse(databaseCreationPaused());
    }
    if (error instanceof WorkIntakeValidationError || error instanceof DefaultProjectResolutionError) {
      return jsonError(error.message, error.status);
    }
    return jsonError("Failed to process work intake", 500);
  }
}
