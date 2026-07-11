ALTER TABLE "managed_giveaways"
ADD COLUMN IF NOT EXISTS "send_lock_key" TEXT;
