-- Multi-user auth. Single-password mode stays working as a compatibility
-- fallback — the middleware only enforces user sessions once at least one
-- row exists in `users`.

CREATE TABLE IF NOT EXISTS "users" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email"          varchar(255) UNIQUE NOT NULL,
  "display_name"   varchar(255),
  "password_hash"  text NOT NULL,
  "is_active"      boolean NOT NULL DEFAULT true,
  "is_system_owner" boolean NOT NULL DEFAULT false,
  "created_at"     timestamp NOT NULL DEFAULT now(),
  "updated_at"     timestamp NOT NULL DEFAULT now()
);

-- `hive_memberships` — who can see / act on which hives, at what level.
-- A single user can belong to many hives with different roles (owner of
-- their own hive, viewer on another owner's hive, etc.)
CREATE TABLE IF NOT EXISTS "hive_memberships" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"    uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "hive_id"    uuid NOT NULL REFERENCES "hives"("id") ON DELETE CASCADE,
  "role"       varchar(32) NOT NULL DEFAULT 'member',  -- owner | member | viewer
  "created_at" timestamp NOT NULL DEFAULT now(),
  UNIQUE ("user_id", "hive_id")
);

CREATE INDEX IF NOT EXISTS "idx_hive_memberships_user"
  ON "hive_memberships" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_hive_memberships_hive"
  ON "hive_memberships" ("hive_id");
