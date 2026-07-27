CREATE INDEX CONCURRENTLY IF NOT EXISTS "vk_parsing_posts_chat_published_message_idx"
ON "vk_parsing_posts"("chat_id", "published_message_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "managed_giveaways_chat_publication_message_idx"
ON "managed_giveaways"("source_chat_id", "publication_message_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "managed_giveaways_chat_results_message_idx"
ON "managed_giveaways"("source_chat_id", "results_message_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_auto_comment_attach_markers_chat_reply_idx"
ON "chat_auto_comment_attach_markers"("chat_id", "reply_message_id");
