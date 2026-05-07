import type { NextResponse } from "next/server";
import { hasValidInternalServiceBearer } from "@/lib/internal-service-auth";

// Per-handler auth check used as defense-in-depth for every protected
// /api/* route. The framework-level gate lives in `src/proxy.ts`; handlers
// should not depend on that because the middleware matcher and allowlist
// are mutable. Returning a 401 here keeps the invariant enforced even if
// the middleware is bypassed (e.g. matcher typo, handler called directly
// from another server-side module, future edge-runtime reshuffle).
//
// Test bypass: vitest runs handlers as direct function imports and cannot
// supply a NextAuth session. We detect the vitest runtime via the VITEST
// env var (set by vitest itself) and skip the session check so existing
// handler tests keep working without needing per-file session mocks.
// The NextAuth/`next/server` modules are loaded lazily so the test bypass
// short-circuits before those modules are evaluated — next-auth's internal
// `import "next/server"` (no `.js`) is not resolvable by vitest's node
// ESM resolver, so a top-level static import would break every handler test.

// Service-account identity for in-process callers (EA, dispatcher-spawned
// goal supervisors) that authenticate via the INTERNAL_SERVICE_TOKEN bearer
// rather than a NextAuth session. Treated as system-owner since these are
// trusted local subsystems, not external principals.
const SERVICE_ACCOUNT_ID = "internal-service-account";
const SERVICE_ACCOUNT_EMAIL = "service@hivewright.local";

async function hasValidInternalBearer(): Promise<boolean> {
  try {
    const { headers } = await import("next/headers");
    const hs = await headers();
    return hasValidInternalServiceBearer(
      hs.get("authorization"),
      process.env.INTERNAL_SERVICE_TOKEN,
    );
  } catch {
    return false;
  }
}

async function getRequestHeader(name: string): Promise<string | null> {
  try {
    const { headers } = await import("next/headers");
    const hs = await headers();
    return hs.get(name);
  } catch {
    return null;
  }
}

export async function requireApiAuth(): Promise<NextResponse | null> {
  if (process.env.VITEST === "true") return null;
  if (await hasValidInternalBearer()) return null;
  const { auth } = await import("@/auth");
  const { NextResponse } = await import("next/server");
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export type ApiSessionUser = {
  id?: string | null;
  email?: string | null;
  name?: string | null;
};

// Variant that returns the session user on success, for handlers that need
// the caller identity (audit attribution, authorization). Same 401 response
// shape on failure.
export async function requireApiAuthWithUser():
  Promise<{ user: ApiSessionUser } | { response: NextResponse }> {
  if (process.env.VITEST === "true") {
    return { user: { id: "test-user", email: "test@local", name: "Test" } };
  }
  if (await hasValidInternalBearer()) {
    return {
      user: { id: SERVICE_ACCOUNT_ID, email: SERVICE_ACCOUNT_EMAIL, name: "Internal Service" },
    };
  }
  const { auth } = await import("@/auth");
  const { NextResponse } = await import("next/server");
  const session = await auth();
  if (!session?.user) {
    return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  return { user: session.user };
}

// Caller identity resolved via users-table lookup from the NextAuth session
// email. Per-handler authorization uses isSystemOwner to gate privileged
// operations (credentials, dispatcher restart, etc.) while role propagation
// via JWT is still pending.
export interface AuthenticatedApiUser {
  id: string;
  email: string;
  isSystemOwner: boolean;
}

export function isInternalServiceAccountUser(
  user: Pick<AuthenticatedApiUser, "id">,
): boolean {
  return user.id === SERVICE_ACCOUNT_ID;
}

// Bootstrap identity — no users row yet, login uses the development-only
// default or an explicit DASHBOARD_PASSWORD (see src/auth.ts `authorize`).
// Treated as system owner since by construction no other principals exist
// in that state.
const BOOTSTRAP_EMAIL = "owner@hivewright.local";

export async function requireApiUser():
  Promise<{ user: AuthenticatedApiUser } | { response: NextResponse }> {
  if (process.env.VITEST === "true") {
    return {
      user: { id: "test-user", email: "test@local", isSystemOwner: true },
    };
  }
  if (await hasValidInternalBearer()) {
    return {
      user: {
        id: SERVICE_ACCOUNT_ID,
        email: SERVICE_ACCOUNT_EMAIL,
        isSystemOwner: true,
      },
    };
  }
  const { auth } = await import("@/auth");
  const { NextResponse } = await import("next/server");
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (email === BOOTSTRAP_EMAIL) {
    return {
      user: { id: "owner-bootstrap", email, isSystemOwner: true },
    };
  }
  const { sql } = await import("./db");
  const [row] = await sql<{ id: string; email: string; isSystemOwner: boolean }[]>`
    SELECT id, email, is_system_owner AS "isSystemOwner"
    FROM users
    WHERE lower(email) = lower(${email}) AND is_active = true
    LIMIT 1
  `;
  if (!row) {
    return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  return { user: { id: row.id, email: row.email, isSystemOwner: Boolean(row.isSystemOwner) } };
}

// System-owner gate for privileged endpoints (credentials mutation,
// dispatcher restart, task creation while role propagation is pending).
// Returns 401 for missing/unknown session, 403 for known non-owner.
export async function requireSystemOwner():
  Promise<{ user: AuthenticatedApiUser } | { response: NextResponse }> {
  const result = await requireApiUser();
  if ("response" in result) return result;
  if (!result.user.isSystemOwner) {
    const { NextResponse } = await import("next/server");
    return {
      response: NextResponse.json(
        { error: "Forbidden: system owner role required" },
        { status: 403 },
      ),
    };
  }
  return result;
}

export type InternalTaskScope = {
  taskId: string;
  hiveId: string;
  assignedTo: string;
  parentTaskId: string | null;
};

export async function getInternalTaskScope():
  Promise<{ ok: true; scope: InternalTaskScope | null } | { ok: false; response: NextResponse }> {
  if (!(await hasValidInternalBearer())) return { ok: true, scope: null };

  const taskIdHeader = await getRequestHeader("x-hivewright-task-id");
  if (taskIdHeader === null) return { ok: true, scope: null };

  const taskId = taskIdHeader.trim();
  if (!taskId) {
    const { NextResponse } = await import("next/server");
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Forbidden: invalid task scope" },
        { status: 403 },
      ),
    };
  }

  const { sql } = await import("./db");
  const [task] = await sql<InternalTaskScope[]>`
    SELECT
      id AS "taskId",
      hive_id AS "hiveId",
      assigned_to AS "assignedTo",
      parent_task_id AS "parentTaskId"
    FROM tasks
    WHERE id = ${taskId}
    LIMIT 1
  `;
  if (!task) {
    const { NextResponse } = await import("next/server");
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Forbidden: invalid task scope" },
        { status: 403 },
      ),
    };
  }

  return { ok: true, scope: task };
}

export async function enforceInternalTaskHiveScope(
  requestedHiveId: string,
): Promise<{ ok: true; scope: InternalTaskScope | null } | { ok: false; response: NextResponse }> {
  const scoped = await getInternalTaskScope();
  if (!scoped.ok) return scoped;
  if (!scoped.scope) return scoped;
  if (scoped.scope.hiveId === requestedHiveId) return scoped;

  const { NextResponse } = await import("next/server");
  return {
    ok: false,
    response: NextResponse.json(
      { error: "Forbidden: task scope cannot write to this hive" },
      { status: 403 },
    ),
  };
}
