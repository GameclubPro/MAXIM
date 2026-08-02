-- Dashboard reads moved to chat_membership_activity_feed_items.
DROP INDEX CONCURRENTLY IF EXISTS "chat_membership_activity_events_dashboard_idx";
