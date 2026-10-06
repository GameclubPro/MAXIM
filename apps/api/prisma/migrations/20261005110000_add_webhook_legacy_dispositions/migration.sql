-- FLAG: Empty additive safety state. Runtime never creates these records. Only a
-- reviewed offline all-role stop/install/seal may release ordering; unknown effects
-- and their independent holds are never represented as successful executions.
CREATE TABLE "webhook_legacy_quiescence_certificates" (
  "id" TEXT PRIMARY KEY,
  "authority_version" INTEGER NOT NULL DEFAULT 1,
  "source_sha" TEXT NOT NULL,
  "image_id" TEXT NOT NULL,
  "attestation" JSONB NOT NULL,
  "attestation_digest" TEXT NOT NULL,
  "preview_sha256" TEXT NOT NULL,
  "quiesced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sealed_at" TIMESTAMP(3),
  "recovery_count" INTEGER NOT NULL DEFAULT 0,
  "child_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("authority_version" = 1 AND "recovery_count" >= 0 AND "child_count" >= 0),
  CHECK ("source_sha" ~ '^[0-9a-f]{40}$' AND "image_id" ~ '^sha256:[0-9a-f]{64}$'),
  CHECK ("attestation_digest" ~ '^[0-9a-f]{64}$' AND "preview_sha256" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "webhook_legacy_recoveries" (
  "id" TEXT PRIMARY KEY,
  "authority_version" INTEGER NOT NULL DEFAULT 1,
  "disposition" TEXT NOT NULL DEFAULT 'NO_REPLAY_ORDER_RELEASED',
  "semantic_key" TEXT NOT NULL UNIQUE,
  "owner_webhook_event_id" TEXT NOT NULL UNIQUE,
  "claim_id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "message_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "source_at" TIMESTAMP(3) NOT NULL,
  "raw_payload_digest" TEXT NOT NULL,
  "normalized_payload_digest" TEXT NOT NULL,
  "owner_snapshot" JSONB NOT NULL,
  "claim_snapshot" JSONB NOT NULL,
  "settings_snapshot" JSONB NOT NULL,
  "certificate_id" TEXT NOT NULL REFERENCES "webhook_legacy_quiescence_certificates"("id") ON DELETE RESTRICT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("authority_version" = 1 AND "disposition" = 'NO_REPLAY_ORDER_RELEASED'),
  CHECK (BTRIM("chat_id") <> '' AND BTRIM("message_id") <> '' AND BTRIM("user_id") <> ''),
  CHECK ("raw_payload_digest" ~ '^[0-9a-f]{64}$' AND "normalized_payload_digest" ~ '^[0-9a-f]{64}$')
);
CREATE INDEX "webhook_legacy_recoveries_chat_message_idx" ON "webhook_legacy_recoveries"("chat_id", "message_id");
CREATE INDEX "webhook_legacy_recoveries_chat_user_idx" ON "webhook_legacy_recoveries"("chat_id", "user_id");
CREATE INDEX "webhook_legacy_recoveries_global_user_idx" ON "webhook_legacy_recoveries"("user_id");
CREATE INDEX "webhook_legacy_recoveries_certificate_idx" ON "webhook_legacy_recoveries"("certificate_id");

CREATE TABLE "webhook_legacy_child_holds" (
  "job_key" TEXT PRIMARY KEY,
  "queue_name" TEXT NOT NULL,
  "job_payload_digest" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "message_id" TEXT,
  "user_id" TEXT,
  "certificate_id" TEXT NOT NULL REFERENCES "webhook_legacy_quiescence_certificates"("id") ON DELETE RESTRICT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (BTRIM("job_key") <> '' AND BTRIM("queue_name") <> '' AND BTRIM("chat_id") <> ''),
  CHECK ("job_payload_digest" ~ '^[0-9a-f]{64}$')
);
CREATE INDEX "webhook_legacy_child_holds_certificate_idx" ON "webhook_legacy_child_holds"("certificate_id");
