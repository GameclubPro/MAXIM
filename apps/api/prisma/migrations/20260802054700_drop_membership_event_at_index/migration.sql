-- Keep the raw chat/user lookup index used outside dashboard reads.
DROP INDEX CONCURRENTLY IF EXISTS "chat_membership_activity_events_chat_id_event_at_idx";
