ALTER TABLE "chat_rules"
  ADD COLUMN "published_bot_id" TEXT;

ALTER TABLE "managed_giveaways"
  ADD COLUMN "publication_bot_id" TEXT,
  ADD COLUMN "results_bot_id" TEXT;
