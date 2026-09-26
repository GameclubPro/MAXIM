CREATE TYPE "PublicationOccurrenceStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'AMBIGUOUS', 'FAILED', 'COMPLETED', 'CANCELED');
CREATE TYPE "PublicationDispatchProfile" AS ENUM ('PUBLIK_V1', 'LEGACY_ROUTED');
CREATE TABLE publications (
  id TEXT PRIMARY KEY, actor_user_id TEXT, lifecycle TEXT,
  audience_mode TEXT, audience_selection TEXT, dispatch_profile "PublicationDispatchProfile",
  required_bot_id TEXT, title TEXT
);
CREATE TABLE publication_schedules (id TEXT PRIMARY KEY, mode TEXT, status TEXT, revision INTEGER, rule JSONB);
CREATE TABLE publication_occurrences (
  id TEXT PRIMARY KEY, publication_id TEXT, schedule_id TEXT,
  status "PublicationOccurrenceStatus", scheduled_at TIMESTAMPTZ,
  dispatch_profile "PublicationDispatchProfile", required_bot_id TEXT,
  dispatch_blocker_code TEXT, content_revision_id TEXT
);
CREATE INDEX publication_occurrences_dispatch_status_scheduled_idx
  ON publication_occurrences(dispatch_profile, status, scheduled_at);
CREATE TABLE publication_targets (publication_id TEXT, target_chat_id TEXT, entity_type TEXT, position INTEGER);
CREATE UNIQUE INDEX publication_targets_publication_position_key ON publication_targets(publication_id, position);
CREATE TABLE managed_entity_access_edges (
  chat_id TEXT, user_id TEXT, bot_id TEXT, state TEXT, user_role TEXT,
  entity_type TEXT, checked_at TIMESTAMPTZ, expires_at TIMESTAMPTZ, denied_reason TEXT,
  last_max_error_message TEXT, PRIMARY KEY(chat_id, user_id, bot_id)
);
CREATE TABLE managed_bot_chat_catalog (
  bot_id TEXT, chat_id TEXT, status TEXT, entity_type TEXT, title TEXT,
  PRIMARY KEY(bot_id, chat_id)
);
CREATE TABLE managed_broadcast_deliveries (
  id TEXT PRIMARY KEY, publication_occurrence_id TEXT, created_at TIMESTAMPTZ,
  status TEXT, attempt_count INTEGER, remote_message_id TEXT, last_error TEXT
);
CREATE INDEX managed_broadcast_deliveries_pub_occurrence_created_id_idx
  ON managed_broadcast_deliveries(publication_occurrence_id, created_at DESC, id DESC);
CREATE TABLE chats (id TEXT PRIMARY KEY, entity_type TEXT, title TEXT);
CREATE TABLE IF NOT EXISTS publisher_entity_bindings (
  chat_id TEXT PRIMARY KEY, publisher_bot_id TEXT, status TEXT, bot_access_state TEXT,
  bot_access_checked_at TIMESTAMPTZ, bot_access_expires_at TIMESTAMPTZ,
  send_route_quarantined_until TIMESTAMPTZ, last_webhook_at TIMESTAMPTZ,
  bot_access_source TEXT
);
CREATE TABLE IF NOT EXISTS managed_entity_publication_policies (
  chat_id TEXT PRIMARY KEY, publik_enabled BOOLEAN, updated_by_user_id TEXT
);
