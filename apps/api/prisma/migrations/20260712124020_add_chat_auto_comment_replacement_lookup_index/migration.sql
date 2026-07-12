-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_auto_comment_attach_markers_chat_replacement_idx"
ON "chat_auto_comment_attach_markers"("chat_id", "replacement_message_id");
