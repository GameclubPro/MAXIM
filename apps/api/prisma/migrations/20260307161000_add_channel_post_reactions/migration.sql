ALTER TABLE "channel_posts"
ADD COLUMN "latest_reactions" JSONB,
ADD COLUMN "latest_reactions_total" INTEGER NOT NULL DEFAULT 0;
