ALTER TABLE "chat_settings"
  ADD COLUMN "karavan_storefront_admins_only" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "karavan_storefront_allowlist" (
  "id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "display_name" TEXT,
  "expires_at" TIMESTAMP(3),
  "created_by_user_id" TEXT NOT NULL,
  "source_message_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "karavan_storefront_allowlist_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "karavan_storefront_allowlist_chat_id_user_id_key"
  ON "karavan_storefront_allowlist"("chat_id", "user_id");

CREATE INDEX "karavan_storefront_allowlist_chat_id_expires_at_idx"
  ON "karavan_storefront_allowlist"("chat_id", "expires_at");

CREATE INDEX "karavan_storefront_allowlist_user_id_expires_at_idx"
  ON "karavan_storefront_allowlist"("user_id", "expires_at");

ALTER TABLE "karavan_storefront_allowlist"
  ADD CONSTRAINT "karavan_storefront_allowlist_chat_id_fkey"
  FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
