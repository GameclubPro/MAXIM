CREATE TYPE "PublicationOccurrenceStatus" AS ENUM ('SCHEDULED','IN_PROGRESS','SENT','PARTIAL','FAILED','AMBIGUOUS','CANCELED');
CREATE TYPE "PublicationDispatchProfile" AS ENUM ('LEGACY_ROUTED','PUBLIK_V1');
CREATE TYPE "ChatEntityType" AS ENUM ('CHAT','CHANNEL');
CREATE TABLE publications (
  id text PRIMARY KEY, actor_user_id text NOT NULL DEFAULT 'private-actor', lifecycle text NOT NULL DEFAULT 'ACTIVE',
  audience_mode text NOT NULL DEFAULT 'SNAPSHOT', dispatch_profile "PublicationDispatchProfile" NOT NULL DEFAULT 'PUBLIK_V1',
  required_bot_id text NOT NULL DEFAULT 'private-bot', canonical_content_revision_id text NOT NULL DEFAULT 'private-content',
  version integer NOT NULL DEFAULT 1, created_at timestamp(3) NOT NULL DEFAULT '2026-10-19T20:00:00',
  updated_at timestamp(3) NOT NULL DEFAULT '2026-10-19T20:00:00'
);
CREATE TABLE publication_schedules (
  id text PRIMARY KEY, publication_id text NOT NULL REFERENCES publications(id), mode text NOT NULL DEFAULT 'ONCE',
  revision integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamp(3) NOT NULL DEFAULT '2026-10-19T20:00:00', updated_at timestamp(3) NOT NULL DEFAULT '2026-10-19T20:00:00'
);
CREATE TABLE publication_occurrences (
  id text PRIMARY KEY, publication_id text NOT NULL REFERENCES publications(id), schedule_id text NOT NULL REFERENCES publication_schedules(id),
  content_revision_id text NOT NULL DEFAULT 'private-content', schedule_revision integer NOT NULL DEFAULT 1,
  scheduled_at timestamp(3) NOT NULL DEFAULT '2026-10-19T22:00:00', status "PublicationOccurrenceStatus" NOT NULL DEFAULT 'SCHEDULED',
  legacy_broadcast_id text, dispatch_profile "PublicationDispatchProfile" NOT NULL DEFAULT 'PUBLIK_V1', required_bot_id text NOT NULL DEFAULT 'private-bot',
  dispatch_blocker_code text, dispatch_blocked_at timestamp(3), dispatch_first_blocked_at timestamp(3),
  retry_authorized_at timestamp(3), retry_expires_at timestamp(3), delivery_deadline_at timestamp(3) DEFAULT '2026-10-20T22:00:00',
  created_at timestamp(3) NOT NULL DEFAULT '2026-10-19T20:00:00', updated_at timestamp(3) NOT NULL DEFAULT '2026-10-19T20:00:00'
);
CREATE INDEX publication_occurrences_ready_dispatch_idx ON publication_occurrences(dispatch_profile,status,dispatch_blocker_code,scheduled_at,id);
CREATE TABLE publication_targets (
  id text PRIMARY KEY, publication_id text NOT NULL REFERENCES publications(id), target_chat_id text NOT NULL, entity_type "ChatEntityType" NOT NULL DEFAULT 'CHANNEL',
  position integer NOT NULL, created_at timestamp(3) NOT NULL DEFAULT '2026-10-19T20:00:00'
);
CREATE UNIQUE INDEX publication_targets_publication_position_key ON publication_targets(publication_id,position);
CREATE TABLE managed_broadcasts (
  id text PRIMARY KEY, entity_type "ChatEntityType" NOT NULL DEFAULT 'CHANNEL', sent_count integer NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'ACTIVE',
  next_send_at timestamp(3) DEFAULT '2026-10-19T22:00:00', locked_at timestamp(3), lock_token text,
  cycle_enabled boolean NOT NULL DEFAULT false, cycle_count integer NOT NULL DEFAULT 1, apply_to_all_chats boolean NOT NULL DEFAULT false,
  target_chat_ids jsonb NOT NULL DEFAULT '[]', last_error text,
  publication_occurrence_id text REFERENCES publication_occurrences(id), publication_content_revision_id text DEFAULT 'private-content',
  dispatch_profile "PublicationDispatchProfile" NOT NULL DEFAULT 'PUBLIK_V1', required_bot_id text NOT NULL DEFAULT 'private-bot',
  created_at timestamp(3) NOT NULL DEFAULT '2026-10-19T20:00:00', updated_at timestamp(3) NOT NULL DEFAULT '2026-10-19T20:00:00'
);
CREATE UNIQUE INDEX managed_broadcasts_pub_occurrence_entity_key ON managed_broadcasts(publication_occurrence_id,entity_type);
CREATE TABLE managed_broadcast_occurrences (
  id text PRIMARY KEY, broadcast_id text NOT NULL REFERENCES managed_broadcasts(id), occurrence_index integer NOT NULL DEFAULT 1,
  scheduled_at timestamp(3) NOT NULL DEFAULT '2026-10-19T22:00:00', status text NOT NULL DEFAULT 'ACTIVE',
  updated_at timestamp(3) NOT NULL DEFAULT '2026-10-19T20:00:00'
);
CREATE UNIQUE INDEX managed_broadcast_occurrences_broadcast_occurrence_key ON managed_broadcast_occurrences(broadcast_id,occurrence_index);
CREATE TABLE managed_broadcast_deliveries (
  id text PRIMARY KEY, broadcast_id text NOT NULL REFERENCES managed_broadcasts(id), occurrence_index integer NOT NULL DEFAULT 1,
  target_chat_id text NOT NULL, bot_id text, status text NOT NULL DEFAULT 'PENDING', attempt_count integer NOT NULL DEFAULT 0,
  remote_message_id text, remote_message_verified_at timestamp(3), remote_message_verification_attempt_count integer NOT NULL DEFAULT 0,
  remote_message_verification_absent_count integer NOT NULL DEFAULT 0, remote_message_verification_present_count integer NOT NULL DEFAULT 0,
  remote_message_verification_attempted_at timestamp(3), remote_message_verification_next_at timestamp(3), remote_message_verification_last_error text,
  remote_message_verification_source text, legacy_sent_without_remote_id boolean NOT NULL DEFAULT false, sent_at timestamp(3),
  post_actions_next_at timestamp(3), post_actions_token text, subscription_delete_id text, pin_status text NOT NULL DEFAULT 'NONE',
  pin_attempt_count integer NOT NULL DEFAULT 0, pin_error text, delete_status text NOT NULL DEFAULT 'NONE', delete_at timestamp(3),
  deleted_at timestamp(3), delete_attempt_count integer NOT NULL DEFAULT 0, delete_error text,
  locked_at timestamp(3), lock_token text, publication_occurrence_id text REFERENCES publication_occurrences(id), content_revision_id text DEFAULT 'private-content',
  dispatch_profile "PublicationDispatchProfile" NOT NULL DEFAULT 'PUBLIK_V1', required_bot_id text NOT NULL DEFAULT 'private-bot', dialog_bot_id text,
  last_error_code text, last_error text, created_at timestamp(3) NOT NULL DEFAULT '2026-10-19T20:00:00', updated_at timestamp(3) NOT NULL DEFAULT '2026-10-19T20:00:00'
);
CREATE INDEX managed_broadcast_deliveries_pub_occurrence_created_id_idx ON managed_broadcast_deliveries(publication_occurrence_id,created_at DESC,id DESC);
CREATE UNIQUE INDEX managed_broadcast_deliveries_broadcast_occurrence_target_key ON managed_broadcast_deliveries(broadcast_id,occurrence_index,target_chat_id);
CREATE TABLE max_action_ledger (id text PRIMARY KEY, job_id text NOT NULL);
CREATE UNIQUE INDEX max_action_ledger_job_id_key ON max_action_ledger(job_id);
