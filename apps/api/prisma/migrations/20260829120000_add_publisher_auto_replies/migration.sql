CREATE TYPE "PublisherAutoReplyDeliveryStatus" AS ENUM (
  'PENDING',
  'SENDING',
  'SENT',
  'FAILED',
  'AMBIGUOUS',
  'CANCELED'
);

CREATE TYPE "PublisherAutoReplyAssetUploadStatus" AS ENUM (
  'PENDING',
  'UPLOADING',
  'READY',
  'FAILED'
);

CREATE TYPE "PublisherAutoReplyAuthoringState" AS ENUM (
  'AWAITING_START',
  'AWAITING_PHRASE',
  'AWAITING_CONTENT',
  'PROCESSING',
  'REVIEW',
  'SAVING',
  'COMPLETED',
  'CANCELED',
  'FAILED',
  'EXPIRED'
);

CREATE TYPE "PublisherPrivateFlowType" AS ENUM (
  'POST_IMPORT',
  'AUTO_REPLY_AUTHORING'
);

ALTER TABLE "publisher_entity_settings"
  ADD COLUMN "auto_replies_enabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "publisher_auto_reply_rules" (
  "id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "phrase" TEXT NOT NULL,
  "normalized_phrase" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "cooldown_seconds" INTEGER NOT NULL DEFAULT 30,
  "version" INTEGER NOT NULL DEFAULT 1,
  "current_content_revision_id" TEXT,
  "authoring_session_id" TEXT,
  "created_by_user_id" TEXT NOT NULL,
  "updated_by_user_id" TEXT NOT NULL,
  "archived_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "publisher_auto_reply_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "publisher_auto_reply_rules_phrase_check" CHECK (
    BTRIM("phrase") <> ''
    AND CHAR_LENGTH("phrase") <= 80
    AND BTRIM("normalized_phrase") <> ''
    AND CHAR_LENGTH("normalized_phrase") <= 80
  ),
  CONSTRAINT "publisher_auto_reply_rules_cooldown_check"
    CHECK ("cooldown_seconds" BETWEEN 0 AND 86400),
  CONSTRAINT "publisher_auto_reply_rules_version_check" CHECK ("version" >= 1),
  CONSTRAINT "publisher_auto_reply_rules_actor_check" CHECK (
    BTRIM("created_by_user_id") <> '' AND BTRIM("updated_by_user_id") <> ''
  ),
  CONSTRAINT "publisher_auto_reply_rules_chat_id_fkey"
    FOREIGN KEY ("chat_id") REFERENCES "chats"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "publisher_auto_reply_rules_current_content_revision_id_key"
  ON "publisher_auto_reply_rules"("current_content_revision_id");
CREATE UNIQUE INDEX "publisher_auto_reply_rules_active_phrase_key"
  ON "publisher_auto_reply_rules"("chat_id", "normalized_phrase")
  WHERE "archived_at" IS NULL;
CREATE INDEX "publisher_auto_reply_rules_chat_archived_updated_idx"
  ON "publisher_auto_reply_rules"("chat_id", "archived_at", "updated_at" DESC, "id");
CREATE INDEX "publisher_auto_reply_rules_chat_normalized_phrase_idx"
  ON "publisher_auto_reply_rules"("chat_id", "normalized_phrase");
CREATE INDEX "publisher_auto_reply_rules_chat_enabled_archived_idx"
  ON "publisher_auto_reply_rules"("chat_id", "enabled", "archived_at");
CREATE INDEX "publisher_auto_reply_rules_authoring_session_archived_idx"
  ON "publisher_auto_reply_rules"("authoring_session_id", "archived_at");

CREATE TABLE "publisher_auto_reply_content_revisions" (
  "id" TEXT NOT NULL,
  "rule_id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "text" TEXT NOT NULL DEFAULT '',
  "text_format" "PublicationContentFormat" NOT NULL DEFAULT 'PLAIN',
  "created_by_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "publisher_auto_reply_content_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "publisher_auto_reply_content_revisions_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "publisher_auto_reply_content_revisions_text_check"
    CHECK (CHAR_LENGTH("text") <= 4000),
  CONSTRAINT "publisher_auto_reply_content_revisions_actor_check"
    CHECK (BTRIM("created_by_user_id") <> ''),
  CONSTRAINT "publisher_auto_reply_content_revisions_rule_id_fkey"
    FOREIGN KEY ("rule_id") REFERENCES "publisher_auto_reply_rules"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "publisher_auto_reply_content_revisions_rule_revision_key"
  ON "publisher_auto_reply_content_revisions"("rule_id", "revision");
CREATE INDEX "publisher_auto_reply_content_revisions_rule_created_idx"
  ON "publisher_auto_reply_content_revisions"("rule_id", "created_at" DESC);

ALTER TABLE "publisher_auto_reply_rules"
  ADD CONSTRAINT "publisher_auto_reply_rules_current_content_revision_id_fkey"
  FOREIGN KEY ("current_content_revision_id")
  REFERENCES "publisher_auto_reply_content_revisions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "publisher_auto_reply_assets" (
  "id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "file_name" TEXT NOT NULL DEFAULT '',
  "size_bytes" INTEGER NOT NULL,
  "bytes" BYTEA NOT NULL,
  "created_by_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "publisher_auto_reply_assets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "publisher_auto_reply_assets_sha256_check"
    CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "publisher_auto_reply_assets_mime_check"
    CHECK (LOWER("mime_type") LIKE 'image/%' AND CHAR_LENGTH("mime_type") <= 128),
  CONSTRAINT "publisher_auto_reply_assets_size_check"
    CHECK ("size_bytes" BETWEEN 1 AND 8388608 AND OCTET_LENGTH("bytes") = "size_bytes"),
  CONSTRAINT "publisher_auto_reply_assets_file_name_check"
    CHECK (CHAR_LENGTH("file_name") <= 128),
  CONSTRAINT "publisher_auto_reply_assets_actor_check"
    CHECK (BTRIM("created_by_user_id") <> ''),
  CONSTRAINT "publisher_auto_reply_assets_chat_id_fkey"
    FOREIGN KEY ("chat_id") REFERENCES "chats"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "publisher_auto_reply_assets_chat_sha256_key"
  ON "publisher_auto_reply_assets"("chat_id", "sha256");
CREATE INDEX "publisher_auto_reply_assets_chat_created_idx"
  ON "publisher_auto_reply_assets"("chat_id", "created_at" DESC);

CREATE TABLE "publisher_auto_reply_content_assets" (
  "content_revision_id" TEXT NOT NULL,
  "asset_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL,

  CONSTRAINT "publisher_auto_reply_content_assets_pkey"
    PRIMARY KEY ("content_revision_id", "asset_id"),
  CONSTRAINT "publisher_auto_reply_content_assets_position_check"
    CHECK ("position" BETWEEN 0 AND 9),
  CONSTRAINT "publisher_auto_reply_content_assets_content_revision_id_fkey"
    FOREIGN KEY ("content_revision_id")
    REFERENCES "publisher_auto_reply_content_revisions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "publisher_auto_reply_content_assets_asset_id_fkey"
    FOREIGN KEY ("asset_id") REFERENCES "publisher_auto_reply_assets"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "publisher_auto_reply_content_assets_revision_position_key"
  ON "publisher_auto_reply_content_assets"("content_revision_id", "position");
CREATE INDEX "publisher_auto_reply_content_assets_asset_id_idx"
  ON "publisher_auto_reply_content_assets"("asset_id");

CREATE TABLE "publisher_auto_reply_mutation_records" (
  "id" TEXT NOT NULL,
  "actor_user_id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "rule_id" TEXT NOT NULL,
  "resulting_version" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "publisher_auto_reply_mutation_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "publisher_auto_reply_mutation_records_values_check" CHECK (
    BTRIM("actor_user_id") <> ''
    AND CHAR_LENGTH("request_id") BETWEEN 8 AND 128
    AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND "operation" IN ('CREATE', 'UPDATE', 'ARCHIVE')
    AND "resulting_version" >= 1
  ),
  CONSTRAINT "publisher_auto_reply_mutation_records_rule_id_fkey"
    FOREIGN KEY ("rule_id") REFERENCES "publisher_auto_reply_rules"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "publisher_auto_reply_mutations_actor_request_key"
  ON "publisher_auto_reply_mutation_records"("actor_user_id", "request_id");
CREATE INDEX "publisher_auto_reply_mutations_rule_created_idx"
  ON "publisher_auto_reply_mutation_records"("rule_id", "created_at" DESC);

CREATE TABLE "publisher_auto_reply_cooldowns" (
  "rule_id" TEXT NOT NULL,
  "source_user_id" TEXT NOT NULL,
  "next_allowed_at" TIMESTAMP(3) NOT NULL,
  "last_source_message_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "publisher_auto_reply_cooldowns_pkey" PRIMARY KEY ("rule_id", "source_user_id"),
  CONSTRAINT "publisher_auto_reply_cooldowns_values_check" CHECK (
    BTRIM("source_user_id") <> ''
    AND BTRIM("last_source_message_id") <> ''
    AND "version" >= 1
  ),
  CONSTRAINT "publisher_auto_reply_cooldowns_rule_id_fkey"
    FOREIGN KEY ("rule_id") REFERENCES "publisher_auto_reply_rules"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "publisher_auto_reply_cooldowns_next_allowed_idx"
  ON "publisher_auto_reply_cooldowns"("next_allowed_at");

CREATE TABLE "publisher_auto_reply_deliveries" (
  "id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "rule_id" TEXT NOT NULL,
  "content_revision_id" TEXT NOT NULL,
  "publisher_bot_id" TEXT NOT NULL,
  "source_message_id" TEXT NOT NULL,
  "source_user_id" TEXT,
  "source_webhook_event_id" TEXT,
  "matched_rule_version" INTEGER NOT NULL,
  "matched_normalized_phrase" TEXT NOT NULL,
  "publisher_settings_revision" INTEGER NOT NULL,
  "publication_policy_revision" INTEGER NOT NULL,
  "status" "PublisherAutoReplyDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "due_at" TIMESTAMP(3) NOT NULL,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "locked_at" TIMESTAMP(3),
  "lock_token" TEXT,
  "dispatch_started_at" TIMESTAMP(3),
  "remote_message_id" TEXT,
  "failure_code" TEXT,
  "failure_message" TEXT,
  "canceled_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "publisher_auto_reply_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "publisher_auto_reply_deliveries_values_check" CHECK (
    BTRIM("publisher_bot_id") <> ''
    AND BTRIM("source_message_id") <> ''
    AND "matched_rule_version" >= 1
    AND BTRIM("matched_normalized_phrase") <> ''
    AND CHAR_LENGTH("matched_normalized_phrase") <= 80
    AND "publisher_settings_revision" >= 0
    AND "publication_policy_revision" >= 0
    AND "attempt_count" >= 0
  ),
  CONSTRAINT "publisher_auto_reply_deliveries_lock_check" CHECK (
    "status" <> 'SENDING'
    OR ("locked_at" IS NOT NULL AND BTRIM(COALESCE("lock_token", '')) <> '')
  ),
  CONSTRAINT "publisher_auto_reply_deliveries_dispatch_check" CHECK (
    "dispatch_started_at" IS NULL OR "attempt_count" >= 1
  ),
  CONSTRAINT "publisher_auto_reply_deliveries_chat_id_fkey"
    FOREIGN KEY ("chat_id") REFERENCES "chats"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "publisher_auto_reply_deliveries_rule_id_fkey"
    FOREIGN KEY ("rule_id") REFERENCES "publisher_auto_reply_rules"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "publisher_auto_reply_deliveries_content_revision_id_fkey"
    FOREIGN KEY ("content_revision_id")
    REFERENCES "publisher_auto_reply_content_revisions"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "publisher_auto_reply_deliveries_chat_source_message_key"
  ON "publisher_auto_reply_deliveries"("chat_id", "source_message_id");
CREATE INDEX "publisher_auto_reply_deliveries_status_due_locked_idx"
  ON "publisher_auto_reply_deliveries"("status", "due_at", "locked_at", "id");
CREATE INDEX "publisher_auto_reply_deliveries_rule_created_idx"
  ON "publisher_auto_reply_deliveries"("rule_id", "created_at" DESC);
CREATE INDEX "publisher_auto_reply_deliveries_content_revision_idx"
  ON "publisher_auto_reply_deliveries"("content_revision_id");

CREATE TABLE "publisher_auto_reply_asset_uploads" (
  "id" TEXT NOT NULL,
  "asset_id" TEXT NOT NULL,
  "publisher_bot_id" TEXT NOT NULL,
  "status" "PublisherAutoReplyAssetUploadStatus" NOT NULL DEFAULT 'PENDING',
  "payload" JSONB,
  "expires_at" TIMESTAMP(3),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "locked_at" TIMESTAMP(3),
  "lock_token" TEXT,
  "failure_code" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "publisher_auto_reply_asset_uploads_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "publisher_auto_reply_asset_uploads_values_check" CHECK (
    BTRIM("publisher_bot_id") <> '' AND "attempt_count" >= 0
  ),
  CONSTRAINT "publisher_auto_reply_asset_uploads_lock_check" CHECK (
    "status" <> 'UPLOADING'
    OR ("locked_at" IS NOT NULL AND BTRIM(COALESCE("lock_token", '')) <> '')
  ),
  CONSTRAINT "publisher_auto_reply_asset_uploads_asset_id_fkey"
    FOREIGN KEY ("asset_id") REFERENCES "publisher_auto_reply_assets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "publisher_auto_reply_asset_uploads_asset_bot_key"
  ON "publisher_auto_reply_asset_uploads"("asset_id", "publisher_bot_id");
CREATE INDEX "publisher_auto_reply_asset_uploads_recovery_idx"
  ON "publisher_auto_reply_asset_uploads"("status", "locked_at", "updated_at");

CREATE TABLE "publisher_auto_reply_authoring_sessions" (
  "id" TEXT NOT NULL,
  "publisher_bot_id" TEXT NOT NULL,
  "actor_user_id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "start_token" TEXT NOT NULL,
  "state" "PublisherAutoReplyAuthoringState" NOT NULL DEFAULT 'AWAITING_START',
  "stage_revision" INTEGER NOT NULL DEFAULT 0,
  "private_chat_id" TEXT,
  "target_chat_id" TEXT NOT NULL,
  "phrase" TEXT,
  "normalized_phrase" TEXT,
  "phrase_message_id" TEXT,
  "content_message_id" TEXT,
  "source_webhook_event_id" TEXT,
  "bot_status_message_id" TEXT,
  "notification_pending" BOOLEAN NOT NULL DEFAULT false,
  "notification_kind" TEXT,
  "notification_revision" INTEGER NOT NULL DEFAULT 0,
  "notification_locked_at" TIMESTAMP(3),
  "notification_lock_token" TEXT,
  "notification_claim_revision" INTEGER,
  "notification_last_ambiguous_revision" INTEGER,
  "notification_dispatch_started_at" TIMESTAMP(3),
  "callback_id" TEXT,
  "rule_id" TEXT,
  "content_revision_id" TEXT,
  "failure_code" TEXT,
  "omissions" JSONB NOT NULL DEFAULT '[]',
  "capture_guard_until" TIMESTAMP(3),
  "locked_at" TIMESTAMP(3),
  "lock_token" TEXT,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "publisher_auto_reply_authoring_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "publisher_auto_reply_sessions_values_check" CHECK (
    BTRIM("publisher_bot_id") <> ''
    AND BTRIM("actor_user_id") <> ''
    AND CHAR_LENGTH("request_id") BETWEEN 8 AND 128
    AND BTRIM("start_token") <> ''
    AND "stage_revision" >= 0
    AND "notification_revision" >= 0
    AND COALESCE("notification_claim_revision", 0) >= 0
    AND COALESCE("notification_last_ambiguous_revision", 0) >= 0
    AND (
      ("phrase" IS NULL AND "normalized_phrase" IS NULL)
      OR (
        BTRIM("phrase") <> '' AND CHAR_LENGTH("phrase") <= 80
        AND BTRIM("normalized_phrase") <> '' AND CHAR_LENGTH("normalized_phrase") <= 80
      )
    )
  ),
  CONSTRAINT "publisher_auto_reply_sessions_notification_lock_check" CHECK (
    "notification_locked_at" IS NULL
    OR (
      BTRIM(COALESCE("notification_lock_token", '')) <> ''
      AND "notification_claim_revision" IS NOT NULL
    )
  ),
  CONSTRAINT "publisher_auto_reply_sessions_notification_dispatch_check" CHECK (
    "notification_dispatch_started_at" IS NULL
    OR (
      "notification_locked_at" IS NOT NULL
      AND BTRIM(COALESCE("notification_lock_token", '')) <> ''
      AND "notification_claim_revision" IS NOT NULL
    )
  ),
  CONSTRAINT "publisher_auto_reply_sessions_target_chat_id_fkey"
    FOREIGN KEY ("target_chat_id") REFERENCES "chats"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "publisher_auto_reply_sessions_rule_id_fkey"
    FOREIGN KEY ("rule_id") REFERENCES "publisher_auto_reply_rules"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "publisher_auto_reply_sessions_content_revision_id_fkey"
    FOREIGN KEY ("content_revision_id")
    REFERENCES "publisher_auto_reply_content_revisions"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "publisher_auto_reply_sessions_start_token_key"
  ON "publisher_auto_reply_authoring_sessions"("start_token");
CREATE UNIQUE INDEX "publisher_auto_reply_sessions_bot_actor_request_key"
  ON "publisher_auto_reply_authoring_sessions"("publisher_bot_id", "actor_user_id", "request_id");
CREATE UNIQUE INDEX "publisher_auto_reply_sessions_bot_phrase_message_key"
  ON "publisher_auto_reply_authoring_sessions"("publisher_bot_id", "phrase_message_id");
CREATE UNIQUE INDEX "publisher_auto_reply_sessions_bot_content_message_key"
  ON "publisher_auto_reply_authoring_sessions"("publisher_bot_id", "content_message_id");
CREATE UNIQUE INDEX "publisher_auto_reply_sessions_one_active_actor_key"
  ON "publisher_auto_reply_authoring_sessions"("publisher_bot_id", "actor_user_id")
  WHERE "state" IN (
    'AWAITING_START',
    'AWAITING_PHRASE',
    'AWAITING_CONTENT',
    'PROCESSING',
    'REVIEW',
    'SAVING'
  );
CREATE INDEX "publisher_auto_reply_sessions_actor_created_idx"
  ON "publisher_auto_reply_authoring_sessions"("publisher_bot_id", "actor_user_id", "created_at" DESC);
CREATE INDEX "publisher_auto_reply_sessions_recovery_idx"
  ON "publisher_auto_reply_authoring_sessions"("state", "locked_at", "updated_at");
CREATE INDEX "publisher_auto_reply_sessions_expiry_idx"
  ON "publisher_auto_reply_authoring_sessions"("state", "expires_at");
CREATE INDEX "publisher_auto_reply_sessions_notification_idx"
  ON "publisher_auto_reply_authoring_sessions"(
    "notification_pending",
    "notification_locked_at",
    "updated_at"
  );

CREATE TABLE "publisher_auto_reply_authoring_messages" (
  "id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "publisher_bot_id" TEXT NOT NULL,
  "message_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "stage_revision" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "publisher_auto_reply_authoring_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "publisher_auto_reply_authoring_messages_values_check" CHECK (
    BTRIM("publisher_bot_id") <> ''
    AND BTRIM("message_id") <> ''
    AND "kind" IN ('PHRASE', 'CONTENT')
    AND "stage_revision" >= 0
  ),
  CONSTRAINT "publisher_auto_reply_authoring_messages_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "publisher_auto_reply_authoring_sessions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "publisher_auto_reply_authoring_messages_bot_message_key"
  ON "publisher_auto_reply_authoring_messages"("publisher_bot_id", "message_id");
CREATE INDEX "publisher_auto_reply_authoring_messages_session_created_idx"
  ON "publisher_auto_reply_authoring_messages"("session_id", "created_at");

CREATE TABLE "publisher_private_flow_leases" (
  "publisher_bot_id" TEXT NOT NULL,
  "actor_user_id" TEXT NOT NULL,
  "flow_type" "PublisherPrivateFlowType" NOT NULL,
  "flow_id" TEXT NOT NULL,
  "lease_token" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "publisher_private_flow_leases_pkey"
    PRIMARY KEY ("publisher_bot_id", "actor_user_id"),
  CONSTRAINT "publisher_private_flow_leases_values_check" CHECK (
    BTRIM("publisher_bot_id") <> ''
    AND BTRIM("actor_user_id") <> ''
    AND BTRIM("flow_id") <> ''
    AND BTRIM("lease_token") <> ''
  )
);

CREATE INDEX "publisher_private_flow_leases_expires_idx"
  ON "publisher_private_flow_leases"("expires_at");
