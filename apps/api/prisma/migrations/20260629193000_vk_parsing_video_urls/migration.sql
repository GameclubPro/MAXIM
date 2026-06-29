ALTER TABLE "vk_parsing_posts"
  ADD COLUMN "video_urls" JSONB NOT NULL DEFAULT '[]'::jsonb;
