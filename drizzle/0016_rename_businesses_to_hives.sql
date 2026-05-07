-- Hive Rename: rename "businesses" → "hives" and all business_id columns → hive_id.
-- Forward-only. Data is preserved by ALTER TABLE ... RENAME (Postgres preserves rows).
-- Drizzle FK constraint name pattern: <table>_<column>_<reftable>_<refcol>_fk

BEGIN;

-- Rename the two tables.
ALTER TABLE businesses RENAME TO hives;
ALTER TABLE business_memory RENAME TO hive_memory;

-- Rename business_id → hive_id on every table that has it.
ALTER TABLE adapter_config RENAME COLUMN business_id TO hive_id;
ALTER TABLE credentials RENAME COLUMN business_id TO hive_id;
ALTER TABLE decisions RENAME COLUMN business_id TO hive_id;
ALTER TABLE entities RENAME COLUMN business_id TO hive_id;
ALTER TABLE entity_relationships RENAME COLUMN business_id TO hive_id;
ALTER TABLE goals RENAME COLUMN business_id TO hive_id;
ALTER TABLE hive_memory RENAME COLUMN business_id TO hive_id;
ALTER TABLE insights RENAME COLUMN business_id TO hive_id;
ALTER TABLE memory_embeddings RENAME COLUMN business_id TO hive_id;
ALTER TABLE notification_preferences RENAME COLUMN business_id TO hive_id;
ALTER TABLE projects RENAME COLUMN business_id TO hive_id;
ALTER TABLE push_subscriptions RENAME COLUMN business_id TO hive_id;
ALTER TABLE role_memory RENAME COLUMN business_id TO hive_id;
ALTER TABLE schedules RENAME COLUMN business_id TO hive_id;
ALTER TABLE skill_drafts RENAME COLUMN business_id TO hive_id;
ALTER TABLE standing_instructions RENAME COLUMN business_id TO hive_id;
ALTER TABLE tasks RENAME COLUMN business_id TO hive_id;
ALTER TABLE work_products RENAME COLUMN business_id TO hive_id;

-- Rename the unique constraint on projects.
ALTER TABLE projects RENAME CONSTRAINT projects_business_slug_unique TO projects_hive_slug_unique;

-- Rename FK constraints to match the new column + table names so future
-- drizzle-kit generations don't try to drop+recreate them.
ALTER TABLE adapter_config RENAME CONSTRAINT adapter_config_business_id_businesses_id_fk TO adapter_config_hive_id_hives_id_fk;
ALTER TABLE credentials RENAME CONSTRAINT credentials_business_id_businesses_id_fk TO credentials_hive_id_hives_id_fk;
ALTER TABLE decisions RENAME CONSTRAINT decisions_business_id_businesses_id_fk TO decisions_hive_id_hives_id_fk;
ALTER TABLE entities RENAME CONSTRAINT entities_business_id_businesses_id_fk TO entities_hive_id_hives_id_fk;
ALTER TABLE entity_relationships RENAME CONSTRAINT entity_relationships_business_id_businesses_id_fk TO entity_relationships_hive_id_hives_id_fk;
ALTER TABLE goals RENAME CONSTRAINT goals_business_id_businesses_id_fk TO goals_hive_id_hives_id_fk;
ALTER TABLE hive_memory RENAME CONSTRAINT business_memory_business_id_businesses_id_fk TO hive_memory_hive_id_hives_id_fk;
ALTER TABLE insights RENAME CONSTRAINT insights_business_id_businesses_id_fk TO insights_hive_id_hives_id_fk;
ALTER TABLE memory_embeddings RENAME CONSTRAINT memory_embeddings_business_id_businesses_id_fk TO memory_embeddings_hive_id_hives_id_fk;
ALTER TABLE notification_preferences RENAME CONSTRAINT notification_preferences_business_id_businesses_id_fk TO notification_preferences_hive_id_hives_id_fk;
ALTER TABLE projects RENAME CONSTRAINT projects_business_id_businesses_id_fk TO projects_hive_id_hives_id_fk;
ALTER TABLE push_subscriptions RENAME CONSTRAINT push_subscriptions_business_id_businesses_id_fk TO push_subscriptions_hive_id_hives_id_fk;
ALTER TABLE role_memory RENAME CONSTRAINT role_memory_business_id_businesses_id_fk TO role_memory_hive_id_hives_id_fk;
ALTER TABLE schedules RENAME CONSTRAINT schedules_business_id_businesses_id_fk TO schedules_hive_id_hives_id_fk;
ALTER TABLE skill_drafts RENAME CONSTRAINT skill_drafts_business_id_businesses_id_fk TO skill_drafts_hive_id_hives_id_fk;
ALTER TABLE standing_instructions RENAME CONSTRAINT standing_instructions_business_id_businesses_id_fk TO standing_instructions_hive_id_hives_id_fk;
ALTER TABLE tasks RENAME CONSTRAINT tasks_business_id_businesses_id_fk TO tasks_hive_id_hives_id_fk;
ALTER TABLE work_products RENAME CONSTRAINT work_products_business_id_businesses_id_fk TO work_products_hive_id_hives_id_fk;

COMMIT;
