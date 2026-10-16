-- FLAG: Additive observation only. No retained reasons are backfilled or rewritten.
SET lock_timeout = '5s';
SET statement_timeout = '30s';
CREATE TABLE "moderation_delete_reason_origins" (
    "reason_id" TEXT NOT NULL,
    "source_webhook_event_id" TEXT NOT NULL,
    "source_receiving_bot_id" TEXT NOT NULL,
    "source_execution_bot_id" TEXT NOT NULL,
    "source_event_at" TIMESTAMP(3) NOT NULL,
    "source_observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_evidence_version" INTEGER NOT NULL,
    CONSTRAINT "moderation_delete_reason_origins_pkey" PRIMARY KEY ("reason_id"),
    CONSTRAINT "moderation_delete_reason_origins_reason_id_fkey" FOREIGN KEY ("reason_id")
      REFERENCES "moderation_delete_intent_reasons"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "moderation_delete_reason_origins_version_check" CHECK ("source_evidence_version" = 1)
);
CREATE INDEX "moderation_delete_reason_origins_source_idx"
ON "moderation_delete_reason_origins" ("source_webhook_event_id", "source_observed_at", "reason_id");
RESET statement_timeout;
RESET lock_timeout;
