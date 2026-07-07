-- CreateEnum
CREATE TYPE "ChatAutoCommentAttachStatus" AS ENUM ('IN_PROGRESS', 'SUCCEEDED', 'SKIPPED');

-- CreateTable
CREATE TABLE "chat_auto_comment_attach_markers" (
    "id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "status" "ChatAutoCommentAttachStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "lock_token" TEXT,
    "locked_at" TIMESTAMP(3),
    "bot_id" TEXT,
    "source" TEXT NOT NULL,
    "delivery_mode" TEXT,
    "replacement_message_id" TEXT,
    "reply_message_id" TEXT,
    "published_url" TEXT,
    "original_deleted" BOOLEAN NOT NULL DEFAULT false,
    "last_error" TEXT,
    "last_status_code" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_auto_comment_attach_markers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chat_auto_comment_attach_markers_chat_message_key" ON "chat_auto_comment_attach_markers"("chat_id", "message_id");

-- CreateIndex
CREATE INDEX "chat_auto_comment_attach_markers_status_locked_at_idx" ON "chat_auto_comment_attach_markers"("status", "locked_at");

-- CreateIndex
CREATE INDEX "chat_auto_comment_attach_markers_chat_updated_idx" ON "chat_auto_comment_attach_markers"("chat_id", "updated_at" DESC);

-- AddForeignKey
ALTER TABLE "chat_auto_comment_attach_markers" ADD CONSTRAINT "chat_auto_comment_attach_markers_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
