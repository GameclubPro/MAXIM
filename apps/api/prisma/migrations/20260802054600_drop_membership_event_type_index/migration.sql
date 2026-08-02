-- Event-type reads moved to chat_membership_activity_feed_items.
DROP INDEX CONCURRENTLY IF EXISTS "chat_membership_activity_events_chat_id_event_type_event_at_idx";
