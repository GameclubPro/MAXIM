ALTER TABLE "managed_broadcasts"
  ADD COLUMN "media_type" TEXT,
  ADD COLUMN "media_payload" JSONB,
  ADD COLUMN "media_mime_type" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "media_file_name" TEXT NOT NULL DEFAULT '';
