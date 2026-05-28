ALTER TABLE "vk_parsing_sources"
  ADD COLUMN "terminal_failure_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "circuit_opened_at" TIMESTAMP(3),
  ADD COLUMN "circuit_reason_code" TEXT,
  ADD COLUMN "circuit_reason" TEXT,
  ADD COLUMN "circuit_retry_at" TIMESTAMP(3);

CREATE INDEX "vk_parsing_sources_status_circuit_opened_idx"
  ON "vk_parsing_sources"("status", "circuit_opened_at");
