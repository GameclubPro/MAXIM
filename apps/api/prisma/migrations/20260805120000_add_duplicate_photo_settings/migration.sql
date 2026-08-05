CREATE TYPE "DuplicatePhotoMatchPreset" AS ENUM ('SAME_IMAGE', 'MINOR_EDITS');

CREATE TYPE "DuplicatePhotoScope" AS ENUM ('SAME_AUTHOR', 'CHAT');

ALTER TABLE "chat_settings"
ADD COLUMN "duplicate_photo_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "duplicate_photo_match_preset" "DuplicatePhotoMatchPreset" NOT NULL DEFAULT 'SAME_IMAGE',
ADD COLUMN "duplicate_photo_scope" "DuplicatePhotoScope" NOT NULL DEFAULT 'SAME_AUTHOR';
