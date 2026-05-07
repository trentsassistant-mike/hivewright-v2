CREATE TABLE IF NOT EXISTS "idempotency_keys" (
  "hive_id" uuid NOT NULL REFERENCES "hives"("id") ON DELETE CASCADE,
  "route" text NOT NULL,
  "key" text NOT NULL,
  "request_hash" text NOT NULL,
  "response_body" jsonb NOT NULL,
  "response_status" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "idempotency_keys_key_length"
    CHECK (char_length("key") <= 255),
  CONSTRAINT "idempotency_keys_key_printable_ascii"
    CHECK ("key" ~ '^[ -~]+$'),
  CONSTRAINT "idempotency_keys_response_status_range"
    CHECK ("response_status" >= 100 AND "response_status" <= 599)
);

CREATE UNIQUE INDEX IF NOT EXISTS "idempotency_keys_scope_idx"
  ON "idempotency_keys" ("hive_id", "route", "key");

CREATE INDEX IF NOT EXISTS "idempotency_keys_created_at_idx"
  ON "idempotency_keys" ("created_at");
