ALTER TABLE "managed_giveaway_entries"
ADD COLUMN "missing_channel_ids" JSONB NOT NULL DEFAULT '[]'::jsonb;
