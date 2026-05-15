ALTER TABLE "chat_rules"
ADD COLUMN IF NOT EXISTS "admin_contact_button_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "admin_contact_button_url" TEXT NOT NULL DEFAULT '';
