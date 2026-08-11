-- Poll lifecycle is scoped by poll ID, so a chat may keep multiple current polls.
DROP INDEX CONCURRENTLY IF EXISTS "managed_polls_chat_current_key";
