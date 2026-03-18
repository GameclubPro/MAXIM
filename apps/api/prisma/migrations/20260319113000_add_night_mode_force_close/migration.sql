ALTER TABLE "chat_settings"
  ADD COLUMN IF NOT EXISTS "night_mode_force_close_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "night_mode_force_close_forever" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "night_mode_force_close_hours" INTEGER NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS "night_mode_force_close_days" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "night_mode_force_close_until" TEXT NOT NULL DEFAULT '';
