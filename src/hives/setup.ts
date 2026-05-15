import fs from "node:fs";
import path from "node:path";
import type { Sql, TransactionSql } from "postgres";
import { getConnectorDefinition } from "@/connectors/registry";
import { storeCredential } from "@/credentials/manager";
import { isValidHiveAddress } from "@/hives/address";
import { seedDefaultSchedules } from "@/hives/seed-schedules";
import { hiveProjectsPath, hiveRootPath, resolveHiveWorkspaceRoot } from "@/hives/workspace-root";

const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type RoleOverride = {
  adapterType?: string;
  recommendedModel?: string;
};

export type ConnectorSetup = {
  connectorSlug: string;
  displayName: string;
  fields: Record<string, string>;
};

export type ProjectSetup = {
  name: string;
  slug: string;
  workspacePath?: string;
  gitRepo?: boolean;
};

export type OperatingPreferences = {
  maxConcurrentAgents?: number;
  proactiveWork?: boolean;
  memorySearch?: boolean;
  requestSorting?: "balanced" | "direct" | "goals";
};

export type HiveSetupRequest = {
  hive?: {
    name?: string;
    slug?: string;
    type?: string;
    description?: string;
    mission?: string;
  };
  roleOverrides?: Record<string, RoleOverride>;
  connectors?: ConnectorSetup[];
  projects?: ProjectSetup[];
  initialGoal?: string;
  operatingPreferences?: OperatingPreferences;
};

export type HiveSetupStep =
  | "hive-record"
  | "role-overrides"
  | "connectors"
  | "projects"
  | "initial-goal";

export class HiveSetupError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "HiveSetupError";
    this.status = status;
  }
}

type SqlExecutor = Sql | TransactionSql;

type RunHiveSetupOptions = {
  failAfterStep?: HiveSetupStep;
};

function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function requireHiveProjectsRoot(hiveSlug: string): string {
  if (!PROJECT_SLUG_RE.test(hiveSlug)) {
    throw new HiveSetupError("We could not prepare the project folders for this hive.");
  }

  const hiveProjectsRoot = hiveProjectsPath(hiveSlug);
  const resolvedRoot = resolveHiveWorkspaceRoot();
  const resolvedHiveProjectsRoot = path.resolve(hiveProjectsRoot);
  if (!isPathInside(resolvedHiveProjectsRoot, resolvedRoot)) {
    throw new HiveSetupError("We could not prepare the project folders for this hive.");
  }

  return resolvedHiveProjectsRoot;
}

function requireContainedWorkspace(candidatePath: string, allowedRoot: string): string {
  const resolvedRoot = path.resolve(allowedRoot);
  const resolvedCandidate = path.resolve(candidatePath);
  if (!isPathInside(resolvedCandidate, resolvedRoot)) {
    throw new HiveSetupError("Project folders must stay inside this hive.");
  }
  return resolvedCandidate;
}

function recordDirectoryIfNew(createdDirectories: Set<string>, directoryPath: string) {
  if (fs.existsSync(directoryPath)) {
    return;
  }
  fs.mkdirSync(directoryPath, { recursive: true });
  createdDirectories.add(directoryPath);
}

function createHiveDirectories(slug: string, createdDirectories: Set<string>) {
  const hiveRoot = hiveRootPath(slug);
  const hiveRootWasMissing = !fs.existsSync(hiveRoot);

  for (const dir of ["projects", "skills", "ea"]) {
    recordDirectoryIfNew(createdDirectories, path.join(hiveRoot, dir));
  }

  if (hiveRootWasMissing && fs.existsSync(hiveRoot)) {
    createdDirectories.add(hiveRoot);
  }
}

function createProjectDirectory(workspacePath: string, createdDirectories: Set<string>) {
  recordDirectoryIfNew(createdDirectories, workspacePath);
}

function isGitRepository(workspacePath: string): boolean {
  return fs.existsSync(path.join(workspacePath, ".git"));
}

function cleanupDirectories(createdDirectories: Set<string>) {
  for (const directoryPath of [...createdDirectories].sort((a, b) => b.length - a.length)) {
    fs.rmSync(directoryPath, { recursive: true, force: true });
  }
}

function maybeFailSetup(step: HiveSetupStep, options: RunHiveSetupOptions | undefined) {
  if (options?.failAfterStep !== step) {
    return;
  }
  throw new Error(`Forced hive setup failure after ${step}.`);
}

export function plainSetupError(err: unknown): string {
  if (err instanceof HiveSetupError) {
    return err.message;
  }
  if (isUniqueHiveAddressError(err)) {
    return "That hive address is already in use. Please choose a different hive name or custom hive address.";
  }
  if (err instanceof Error && err.message) return err.message;
  return "Hive setup did not finish. Please try again.";
}

export function isUniqueHiveAddressError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

function normalizeOperatingPreferences(preferences: OperatingPreferences | undefined): Required<OperatingPreferences> {
  const maxConcurrentAgents = Number(preferences?.maxConcurrentAgents ?? 3);
  return {
    maxConcurrentAgents: Number.isInteger(maxConcurrentAgents) && maxConcurrentAgents >= 1 && maxConcurrentAgents <= 50
      ? maxConcurrentAgents
      : 3,
    proactiveWork: preferences?.proactiveWork ?? true,
    memorySearch: preferences?.memorySearch ?? true,
    requestSorting: preferences?.requestSorting === "direct" || preferences?.requestSorting === "goals"
      ? preferences.requestSorting
      : "balanced",
  };
}

function workIntakeConfigForPreset(preset: Required<OperatingPreferences>["requestSorting"]) {
  const base = {
    primaryProvider: "ollama",
    primaryModel: "qwen3:32b",
    fallbackProvider: "openrouter",
    fallbackModel: "google/gemini-2.0-flash-exp:free",
    timeoutMs: 15000,
    temperature: 0.1,
    maxTokens: 512,
  };

  if (preset === "direct") {
    return { ...base, confidenceThreshold: 0.5, setupPreset: "direct" };
  }
  if (preset === "goals") {
    return { ...base, confidenceThreshold: 0.75, setupPreset: "goals" };
  }
  return { ...base, confidenceThreshold: 0.6, setupPreset: "balanced" };
}

async function saveAdapterConfig(
  tx: SqlExecutor,
  adapterType: string,
  config: Record<string, unknown>,
  hiveId: string | null = null,
) {
  const jsonConfig = config as Parameters<Sql["json"]>[0];
  const existing = hiveId === null
    ? await tx`SELECT id FROM adapter_config WHERE adapter_type = ${adapterType} AND hive_id IS NULL LIMIT 1`
    : await tx`SELECT id FROM adapter_config WHERE adapter_type = ${adapterType} AND hive_id = ${hiveId}::uuid LIMIT 1`;

  if (existing.length > 0) {
    await tx`UPDATE adapter_config SET config = ${tx.json(jsonConfig)}, updated_at = NOW() WHERE id = ${existing[0].id}`;
    return;
  }

  await tx`
    INSERT INTO adapter_config (hive_id, adapter_type, config)
    VALUES (${hiveId}, ${adapterType}, ${tx.json(jsonConfig)})
  `;
}

async function installConnector(tx: SqlExecutor, hiveId: string, connector: ConnectorSetup) {
  const def = getConnectorDefinition(connector.connectorSlug);
  if (!def) {
    throw new HiveSetupError("One selected service is no longer available. Please review your services and try again.");
  }

  for (const field of def.setupFields) {
    if (field.required && !connector.fields[field.key]) {
      throw new HiveSetupError(`Please complete ${field.label} before creating this hive.`);
    }
  }

  const secretValues: Record<string, string> = {};
  const publicConfig: Record<string, string> = {};
  for (const field of def.setupFields) {
    const value = connector.fields[field.key];
    if (value === undefined || value === null || value === "") continue;
    if (def.secretFields.includes(field.key)) {
      secretValues[field.key] = value;
    } else {
      publicConfig[field.key] = value;
    }
  }

  const encryptionKey = process.env.ENCRYPTION_KEY || "";
  let credentialId: string | null = null;
  if (Object.keys(secretValues).length > 0) {
    if (!encryptionKey) {
      throw new HiveSetupError("This service needs a secret, but secure secret storage is not ready. Set it up, then try again.");
    }
    const credential = await storeCredential(tx as unknown as Sql, {
      hiveId,
      name: `${def.name}: ${connector.displayName}`,
      key: `connector:${def.slug}:${Date.now()}`,
      value: JSON.stringify(secretValues),
      rolesAllowed: [],
      encryptionKey,
    });
    credentialId = credential.id;
  }

  await tx`
    INSERT INTO connector_installs (hive_id, connector_slug, display_name, config, credential_id)
    VALUES (${hiveId}::uuid, ${def.slug}, ${connector.displayName}, ${tx.json(publicConfig)}, ${credentialId})
  `;
}

async function saveRoleOverrides(tx: SqlExecutor, roleOverrides: Record<string, RoleOverride>) {
  for (const [roleSlug, override] of Object.entries(roleOverrides)) {
    const updates: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    if (override.adapterType !== undefined) {
      updates.push(`adapter_type = $${idx++}`);
      values.push(override.adapterType);
    }
    if (override.recommendedModel !== undefined) {
      updates.push(`recommended_model = $${idx++}`);
      values.push(override.recommendedModel);
    }
    if (updates.length === 0) continue;

    values.push(roleSlug);
    const rows = await tx.unsafe(
      `UPDATE role_templates SET ${updates.join(", ")} WHERE slug = $${idx} RETURNING slug`,
      values as string[],
    );
    if (rows.length === 0) {
      throw new HiveSetupError("A selected role could not be updated. Please review the runtime choices and try again.");
    }
  }
}

async function validateHiveSetupRequest(sqlClient: Sql, body: HiveSetupRequest) {
  const hive = body.hive ?? {};
  const { name, slug, type } = hive;

  if (!name || !slug || !type) {
    throw new HiveSetupError("Please add a hive name and type before creating it.", 400);
  }
  if (typeof slug !== "string" || !isValidHiveAddress(slug)) {
    throw new HiveSetupError("Please use only lowercase letters, numbers, and dashes for the hive address.", 400);
  }

  const existingHive = await sqlClient`SELECT id FROM hives WHERE slug = ${slug} LIMIT 1`;
  if (existingHive.length > 0) {
    throw new HiveSetupError(
      "That hive address is already in use. Please choose a different hive name or custom hive address.",
      409,
    );
  }

  for (const project of body.projects ?? []) {
    if (!project.name || !project.slug) {
      throw new HiveSetupError("Please complete or remove unfinished projects before creating this hive.", 400);
    }
    if (!PROJECT_SLUG_RE.test(project.slug)) {
      throw new HiveSetupError("Please use only lowercase letters, numbers, and dashes for project addresses.", 400);
    }
  }
}

export async function runHiveSetup(
  sqlClient: Sql,
  body: HiveSetupRequest,
  options?: RunHiveSetupOptions,
) {
  await validateHiveSetupRequest(sqlClient, body);

  const hive = body.hive ?? {};
  const { name, slug, type, description, mission } = hive;
  const connectors = body.connectors ?? [];
  const projects = body.projects ?? [];
  const operatingPreferences = normalizeOperatingPreferences(body.operatingPreferences);
  const createdDirectories = new Set<string>();

  try {
    return await sqlClient.begin(async (tx) => {
      const workspacePath = hiveProjectsPath(slug!);
      const [hiveRow] = await tx`
        INSERT INTO hives (name, slug, type, description, mission, workspace_path)
        VALUES (${name!}, ${slug!}, ${type!}, ${description || null}, ${mission || null}, ${workspacePath})
        RETURNING id, name, slug, type, description
      `;
      const hiveId = hiveRow.id as string;

      createHiveDirectories(slug!, createdDirectories);
      maybeFailSetup("hive-record", options);

      await seedDefaultSchedules(tx as unknown as Sql, {
        id: hiveId,
        name: hiveRow.name as string,
        description: (hiveRow.description as string | null) ?? null,
      }, {
        enabled: operatingPreferences.proactiveWork,
      });

      await saveAdapterConfig(tx, "dispatcher", {
        maxConcurrentTasks: operatingPreferences.maxConcurrentAgents,
        setupPreset: "owner-setup",
      });
      await saveAdapterConfig(tx, "work-intake", workIntakeConfigForPreset(operatingPreferences.requestSorting));
      await saveAdapterConfig(tx, "memory-search", {
        enabled: operatingPreferences.memorySearch,
        prepareOnSetup: operatingPreferences.memorySearch,
        setupPreset: operatingPreferences.memorySearch ? "ready" : "off",
      }, hiveId);

      await saveRoleOverrides(tx, body.roleOverrides ?? {});
      maybeFailSetup("role-overrides", options);

      for (const connector of connectors) {
        await installConnector(tx, hiveId, connector);
      }
      maybeFailSetup("connectors", options);

      const hiveProjectsRoot = requireHiveProjectsRoot(slug!);
      for (const project of projects) {
        const projectWorkspacePath = requireContainedWorkspace(
          project.workspacePath || path.join(hiveProjectsRoot, project.slug),
          hiveProjectsRoot,
        );
        createProjectDirectory(projectWorkspacePath, createdDirectories);
        if (project.gitRepo === true && !isGitRepository(projectWorkspacePath)) {
          throw new HiveSetupError("Git-backed projects must point at an existing Git repository.");
        }
        await tx`
          INSERT INTO projects (hive_id, slug, name, workspace_path, git_repo)
          VALUES (${hiveId}, ${project.slug}, ${project.name}, ${projectWorkspacePath}, ${project.gitRepo === true})
        `;
      }
      maybeFailSetup("projects", options);

      const initialGoal = body.initialGoal?.trim();
      if (initialGoal) {
        const [goal] = await tx`
          INSERT INTO goals (hive_id, title, description)
          VALUES (${hiveId}, ${initialGoal.slice(0, 200)}, ${initialGoal})
          RETURNING id
        `;
        await tx`SELECT pg_notify('new_goal', ${goal.id})`;
      }
      maybeFailSetup("initial-goal", options);

      return { id: hiveId, name: hiveRow.name, slug: hiveRow.slug, type: hiveRow.type };
    });
  } catch (error) {
    cleanupDirectories(createdDirectories);
    throw error;
  }
}
