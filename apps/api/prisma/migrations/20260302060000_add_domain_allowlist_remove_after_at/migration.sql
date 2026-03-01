ALTER TABLE "domain_allowlist"
ADD COLUMN "remove_after_at" TIMESTAMP(3);

CREATE INDEX "domain_allowlist_chat_id_remove_after_at_idx"
ON "domain_allowlist"("chat_id", "remove_after_at");
