DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PublicationLifecycle') THEN
    CREATE TYPE "PublicationLifecycle" AS ENUM (
      'DRAFT',
      'ACTIVE',
      'PAUSED',
      'COMPLETED',
      'CANCELED',
      'ERROR'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PublicationAudienceSelection') THEN
    CREATE TYPE "PublicationAudienceSelection" AS ENUM (
      'SELECTED',
      'ALL_CHATS',
      'ALL_CHANNELS',
      'ALL_MANAGED'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PublicationAudienceMode') THEN
    CREATE TYPE "PublicationAudienceMode" AS ENUM ('SNAPSHOT', 'DYNAMIC');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PublicationContentFormat') THEN
    CREATE TYPE "PublicationContentFormat" AS ENUM ('PLAIN', 'MARKDOWN');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PublicationScheduleMode') THEN
    CREATE TYPE "PublicationScheduleMode" AS ENUM ('NOW', 'ONCE', 'SLOTS', 'RECURRENCE');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PublicationScheduleStatus') THEN
    CREATE TYPE "PublicationScheduleStatus" AS ENUM (
      'DRAFT',
      'ACTIVE',
      'PAUSED',
      'COMPLETED',
      'CANCELED',
      'ERROR'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PublicationOccurrenceStatus') THEN
    CREATE TYPE "PublicationOccurrenceStatus" AS ENUM (
      'SCHEDULED',
      'IN_PROGRESS',
      'SENT',
      'PARTIAL',
      'FAILED',
      'AMBIGUOUS',
      'CANCELED'
    );
  END IF;
END $$;

CREATE TABLE "publications" (
  "id" TEXT NOT NULL,
  "actor_user_id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "title" TEXT NOT NULL DEFAULT '',
  "lifecycle" "PublicationLifecycle" NOT NULL DEFAULT 'DRAFT',
  "audience_selection" "PublicationAudienceSelection" NOT NULL DEFAULT 'SELECTED',
  "audience_mode" "PublicationAudienceMode" NOT NULL DEFAULT 'SNAPSHOT',
  "canonical_content_revision_id" TEXT,
  "legacy_broadcast_id" TEXT,
  "legacy_autopost_rule_id" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "publications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "publications_actor_user_id_check" CHECK (BTRIM("actor_user_id") <> ''),
  CONSTRAINT "publications_request_id_check" CHECK (BTRIM("request_id") <> ''),
  CONSTRAINT "publications_version_check" CHECK ("version" >= 1)
);

CREATE UNIQUE INDEX "publications_actor_request_key"
ON "publications"("actor_user_id", "request_id");

CREATE UNIQUE INDEX "publications_canonical_content_revision_key"
ON "publications"("canonical_content_revision_id");

CREATE UNIQUE INDEX "publications_legacy_broadcast_key"
ON "publications"("legacy_broadcast_id");

CREATE UNIQUE INDEX "publications_legacy_autopost_rule_key"
ON "publications"("legacy_autopost_rule_id");

CREATE INDEX "publications_actor_lifecycle_updated_idx"
ON "publications"("actor_user_id", "lifecycle", "updated_at" DESC, "id" DESC);

CREATE INDEX "publications_lifecycle_updated_idx"
ON "publications"("lifecycle", "updated_at" DESC);

CREATE TABLE "publication_mutation_records" (
  "id" TEXT NOT NULL,
  "actor_user_id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "publication_id" TEXT NOT NULL,
  "resulting_version" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "publication_mutation_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "publication_mutation_records_actor_user_id_check" CHECK (BTRIM("actor_user_id") <> ''),
  CONSTRAINT "publication_mutation_records_request_id_check" CHECK (BTRIM("request_id") <> ''),
  CONSTRAINT "publication_mutation_records_request_hash_check" CHECK (BTRIM("request_hash") <> ''),
  CONSTRAINT "publication_mutation_records_resulting_version_check" CHECK ("resulting_version" >= 1)
);

CREATE UNIQUE INDEX "publication_mutation_records_actor_request_key"
ON "publication_mutation_records"("actor_user_id", "request_id");

CREATE INDEX "publication_mutation_records_publication_created_idx"
ON "publication_mutation_records"("publication_id", "created_at" DESC);

CREATE TABLE "publication_content_revisions" (
  "id" TEXT NOT NULL,
  "publication_id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "text" TEXT NOT NULL DEFAULT '',
  "text_format" "PublicationContentFormat" NOT NULL DEFAULT 'PLAIN',
  "buttons" JSONB NOT NULL DEFAULT '[]',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "publication_content_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "publication_content_revisions_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "publication_content_revisions_buttons_check" CHECK (jsonb_typeof("buttons") = 'array')
);

CREATE UNIQUE INDEX "publication_content_revisions_publication_revision_key"
ON "publication_content_revisions"("publication_id", "revision");

CREATE INDEX "publication_content_revisions_publication_created_idx"
ON "publication_content_revisions"("publication_id", "created_at" DESC);

CREATE TABLE "publication_assets" (
  "id" TEXT NOT NULL,
  "actor_user_id" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "file_name" TEXT NOT NULL DEFAULT '',
  "size_bytes" INTEGER NOT NULL,
  "bytes" BYTEA,
  "durable_payload" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "publication_assets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "publication_assets_actor_user_id_check" CHECK (BTRIM("actor_user_id") <> ''),
  CONSTRAINT "publication_assets_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "publication_assets_mime_type_check" CHECK (BTRIM("mime_type") <> ''),
  CONSTRAINT "publication_assets_size_bytes_check" CHECK ("size_bytes" > 0),
  CONSTRAINT "publication_assets_payload_check" CHECK (
    ("bytes" IS NOT NULL OR "durable_payload" IS NOT NULL)
    AND ("bytes" IS NULL OR OCTET_LENGTH("bytes") = "size_bytes")
    AND ("durable_payload" IS NULL OR jsonb_typeof("durable_payload") = 'object')
  )
);

CREATE UNIQUE INDEX "publication_assets_actor_sha256_key"
ON "publication_assets"("actor_user_id", "sha256");

CREATE INDEX "publication_assets_mime_created_idx"
ON "publication_assets"("mime_type", "created_at" DESC);

CREATE TABLE "publication_content_assets" (
  "content_revision_id" TEXT NOT NULL,
  "asset_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL,

  CONSTRAINT "publication_content_assets_pkey" PRIMARY KEY ("content_revision_id", "asset_id"),
  CONSTRAINT "publication_content_assets_position_check" CHECK ("position" >= 0)
);

CREATE UNIQUE INDEX "publication_content_assets_revision_position_key"
ON "publication_content_assets"("content_revision_id", "position");

CREATE INDEX "publication_content_assets_asset_id_idx"
ON "publication_content_assets"("asset_id");

CREATE TABLE "publication_targets" (
  "id" TEXT NOT NULL,
  "publication_id" TEXT NOT NULL,
  "target_chat_id" TEXT NOT NULL,
  "entity_type" "ChatEntityType" NOT NULL,
  "position" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "publication_targets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "publication_targets_position_check" CHECK ("position" >= 0)
);

CREATE UNIQUE INDEX "publication_targets_publication_target_key"
ON "publication_targets"("publication_id", "target_chat_id");

CREATE UNIQUE INDEX "publication_targets_publication_position_key"
ON "publication_targets"("publication_id", "position");

CREATE INDEX "publication_targets_target_type_idx"
ON "publication_targets"("target_chat_id", "entity_type");

CREATE TABLE "publication_schedules" (
  "id" TEXT NOT NULL,
  "publication_id" TEXT NOT NULL,
  "mode" "PublicationScheduleMode" NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'Europe/Moscow',
  "rule" JSONB NOT NULL DEFAULT '{}',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "status" "PublicationScheduleStatus" NOT NULL DEFAULT 'DRAFT',
  "next_materialize_at" TIMESTAMP(3),
  "last_materialized_at" TIMESTAMP(3),
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "publication_schedules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "publication_schedules_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "publication_schedules_timezone_check" CHECK (BTRIM("timezone") <> ''),
  CONSTRAINT "publication_schedules_rule_check" CHECK (jsonb_typeof("rule") = 'object')
);

CREATE UNIQUE INDEX "publication_schedules_publication_id_key"
ON "publication_schedules"("publication_id");

CREATE INDEX "publication_schedules_status_next_materialize_idx"
ON "publication_schedules"("status", "next_materialize_at");

CREATE TABLE "publication_occurrences" (
  "id" TEXT NOT NULL,
  "publication_id" TEXT NOT NULL,
  "schedule_id" TEXT NOT NULL,
  "content_revision_id" TEXT NOT NULL,
  "schedule_revision" INTEGER NOT NULL,
  "scheduled_at" TIMESTAMP(3) NOT NULL,
  "status" "PublicationOccurrenceStatus" NOT NULL DEFAULT 'SCHEDULED',
  "legacy_broadcast_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "publication_occurrences_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "publication_occurrences_schedule_revision_check" CHECK ("schedule_revision" >= 1)
);

CREATE UNIQUE INDEX "publication_occurrences_publication_revision_slot_key"
ON "publication_occurrences"("publication_id", "schedule_revision", "scheduled_at");

CREATE INDEX "publication_occurrences_schedule_revision_idx"
ON "publication_occurrences"("schedule_id", "schedule_revision");

CREATE INDEX "publication_occurrences_content_revision_idx"
ON "publication_occurrences"("content_revision_id");

CREATE INDEX "publication_occurrences_legacy_broadcast_idx"
ON "publication_occurrences"("legacy_broadcast_id");

CREATE INDEX "publication_occurrences_status_scheduled_idx"
ON "publication_occurrences"("status", "scheduled_at");

CREATE INDEX "publication_occurrences_publication_scheduled_id_idx"
ON "publication_occurrences"("publication_id", "scheduled_at" DESC, "id" DESC);

ALTER TABLE "managed_broadcasts"
  ADD COLUMN "publication_occurrence_id" TEXT,
  ADD COLUMN "publication_content_revision_id" TEXT;

ALTER TABLE "managed_broadcast_deliveries"
  ADD COLUMN "publication_occurrence_id" TEXT;

CREATE UNIQUE INDEX "managed_broadcasts_pub_occurrence_entity_key"
ON "managed_broadcasts"("publication_occurrence_id", "entity_type");

CREATE INDEX "managed_broadcasts_pub_content_revision_idx"
ON "managed_broadcasts"("publication_content_revision_id");

CREATE INDEX "managed_broadcast_deliveries_pub_occurrence_created_id_idx"
ON "managed_broadcast_deliveries"("publication_occurrence_id", "created_at" DESC, "id" DESC);

ALTER TABLE "publication_content_revisions"
  ADD CONSTRAINT "publication_content_revisions_publication_id_fkey"
  FOREIGN KEY ("publication_id") REFERENCES "publications"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "publication_mutation_records"
  ADD CONSTRAINT "publication_mutation_records_publication_id_fkey"
  FOREIGN KEY ("publication_id") REFERENCES "publications"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "publications"
  ADD CONSTRAINT "publications_canonical_content_revision_id_fkey"
  FOREIGN KEY ("canonical_content_revision_id") REFERENCES "publication_content_revisions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "publications"
  ADD CONSTRAINT "publications_legacy_broadcast_id_fkey"
  FOREIGN KEY ("legacy_broadcast_id") REFERENCES "managed_broadcasts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "publications"
  ADD CONSTRAINT "publications_legacy_autopost_rule_id_fkey"
  FOREIGN KEY ("legacy_autopost_rule_id") REFERENCES "managed_autopost_rules"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "publication_content_assets"
  ADD CONSTRAINT "publication_content_assets_content_revision_id_fkey"
  FOREIGN KEY ("content_revision_id") REFERENCES "publication_content_revisions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "publication_content_assets"
  ADD CONSTRAINT "publication_content_assets_asset_id_fkey"
  FOREIGN KEY ("asset_id") REFERENCES "publication_assets"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "publication_targets"
  ADD CONSTRAINT "publication_targets_publication_id_fkey"
  FOREIGN KEY ("publication_id") REFERENCES "publications"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "publication_targets"
  ADD CONSTRAINT "publication_targets_target_chat_id_fkey"
  FOREIGN KEY ("target_chat_id") REFERENCES "chats"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "publication_schedules"
  ADD CONSTRAINT "publication_schedules_publication_id_fkey"
  FOREIGN KEY ("publication_id") REFERENCES "publications"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "publication_occurrences"
  ADD CONSTRAINT "publication_occurrences_publication_id_fkey"
  FOREIGN KEY ("publication_id") REFERENCES "publications"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "publication_occurrences"
  ADD CONSTRAINT "publication_occurrences_schedule_id_fkey"
  FOREIGN KEY ("schedule_id") REFERENCES "publication_schedules"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "publication_occurrences"
  ADD CONSTRAINT "publication_occurrences_content_revision_id_fkey"
  FOREIGN KEY ("content_revision_id") REFERENCES "publication_content_revisions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "publication_occurrences"
  ADD CONSTRAINT "publication_occurrences_legacy_broadcast_id_fkey"
  FOREIGN KEY ("legacy_broadcast_id") REFERENCES "managed_broadcasts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "managed_broadcasts"
  ADD CONSTRAINT "managed_broadcasts_publication_occurrence_id_fkey"
  FOREIGN KEY ("publication_occurrence_id") REFERENCES "publication_occurrences"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "managed_broadcasts"
  ADD CONSTRAINT "managed_broadcasts_publication_content_revision_id_fkey"
  FOREIGN KEY ("publication_content_revision_id") REFERENCES "publication_content_revisions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "managed_broadcast_deliveries"
  ADD CONSTRAINT "managed_broadcast_deliveries_publication_occurrence_id_fkey"
  FOREIGN KEY ("publication_occurrence_id") REFERENCES "publication_occurrences"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
