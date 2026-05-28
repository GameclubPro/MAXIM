ALTER TABLE "vk_parsing_sources"
  ADD COLUMN "sync_lock_deadline_at" TIMESTAMP(3),
  ADD COLUMN "sync_heartbeat_at" TIMESTAMP(3);

CREATE INDEX "vk_parsing_sources_sync_status_deadline_idx"
  ON "vk_parsing_sources"("sync_status", "sync_lock_deadline_at");
