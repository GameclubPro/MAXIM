ALTER TABLE "managed_giveaways"
ADD COLUMN "required_channel_ids" JSONB NOT NULL DEFAULT '[]'::jsonb;
