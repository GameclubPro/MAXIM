-- CreateEnum
CREATE TYPE "ManagedBroadcastStatus" AS ENUM ('ACTIVE', 'FAILED', 'COMPLETED', 'CANCELED');

-- CreateTable
CREATE TABLE "managed_broadcasts" (
    "id" TEXT NOT NULL,
    "source_chat_id" TEXT NOT NULL,
    "entity_type" "ChatEntityType" NOT NULL DEFAULT 'CHAT',
    "actor_user_id" TEXT NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "text_format" TEXT NOT NULL DEFAULT 'plain',
    "apply_to_all_chats" BOOLEAN NOT NULL DEFAULT false,
    "target_chat_ids" JSONB NOT NULL,
    "button_enabled" BOOLEAN NOT NULL DEFAULT false,
    "button_url" TEXT NOT NULL DEFAULT '',
    "button_text" TEXT NOT NULL DEFAULT 'Открыть',
    "image_enabled" BOOLEAN NOT NULL DEFAULT false,
    "image_base64" TEXT NOT NULL DEFAULT '',
    "image_mime_type" TEXT NOT NULL DEFAULT '',
    "image_file_name" TEXT NOT NULL DEFAULT '',
    "next_send_at" TIMESTAMP(3),
    "cycle_enabled" BOOLEAN NOT NULL DEFAULT false,
    "cycle_every_hours" INTEGER NOT NULL DEFAULT 1,
    "cycle_count" INTEGER NOT NULL DEFAULT 1,
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "status" "ManagedBroadcastStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_error" TEXT,
    "locked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "managed_broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "managed_broadcasts_source_chat_id_status_next_send_at_idx" ON "managed_broadcasts"("source_chat_id", "status", "next_send_at");

-- CreateIndex
CREATE INDEX "managed_broadcasts_status_next_send_at_idx" ON "managed_broadcasts"("status", "next_send_at");

-- AddForeignKey
ALTER TABLE "managed_broadcasts" ADD CONSTRAINT "managed_broadcasts_source_chat_id_fkey" FOREIGN KEY ("source_chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
