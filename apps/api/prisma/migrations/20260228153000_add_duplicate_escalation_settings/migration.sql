ALTER TABLE "chat_settings"
ADD COLUMN "duplicate_warn_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "duplicate_kick_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "duplicate_ban_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "duplicate_warn_window_sec" INTEGER NOT NULL DEFAULT 43200,
ADD COLUMN "duplicate_warn_max_count" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN "duplicate_kick_window_sec" INTEGER NOT NULL DEFAULT 86400,
ADD COLUMN "duplicate_kick_max_count" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN "duplicate_ban_window_sec" INTEGER NOT NULL DEFAULT 172800,
ADD COLUMN "duplicate_ban_max_count" INTEGER NOT NULL DEFAULT 4;
