SET lock_timeout = '5s';
SET statement_timeout = '15min';

CREATE INDEX CONCURRENTLY "moderation_events_ordinary_retention_idx"
ON "moderation_events" ("created_at", "id")
WHERE NOT ("action" IN ('MUTE', 'BAN') OR "rule_code" IN ('MANUAL_UNMUTE', 'MANUAL_UNBAN', 'SANCTION_STATE_FENCE'));

CREATE INDEX CONCURRENTLY "moderation_events_sanction_retention_idx"
ON "moderation_events" ("created_at", "id")
WHERE "action" IN ('MUTE', 'BAN') OR "rule_code" IN ('MANUAL_UNMUTE', 'MANUAL_UNBAN', 'SANCTION_STATE_FENCE');

CREATE INDEX CONCURRENTLY "moderation_events_sanction_user_state_idx"
ON "moderation_events" ("chat_id", "user_id", "created_at", "id")
WHERE "action" IN ('MUTE', 'BAN') OR "rule_code" IN ('MANUAL_UNMUTE', 'MANUAL_UNBAN');

CREATE INDEX CONCURRENTLY "chat_moderation_feed_sanctions_idx"
ON "chat_moderation_feed_items" ("chat_id", "created_at" DESC, "id" DESC)
WHERE "action" IN ('MUTE', 'BAN');

CREATE INDEX CONCURRENTLY "chat_moderation_feed_sanction_user_state_idx"
ON "chat_moderation_feed_items" ("chat_id", "user_id", "created_at", "id")
WHERE "action" IN ('MUTE', 'BAN') OR "rule_code" IN ('MANUAL_UNMUTE', 'MANUAL_UNBAN');

RESET statement_timeout;
RESET lock_timeout;
