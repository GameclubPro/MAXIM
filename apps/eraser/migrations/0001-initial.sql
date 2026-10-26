CREATE TABLE eraser_policies (
  chat_id text PRIMARY KEY CHECK (chat_id ~ '^-[1-9][0-9]*$'),
  enabled boolean NOT NULL DEFAULT false,
  hours integer NOT NULL DEFAULT 48 CHECK (hours IN (24,48,168)),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  activation_id uuid NOT NULL,
  last_operation_id uuid,
  enabled_at timestamptz,
  first_enabled_at timestamptz,
  live_floor bigint, live_upper bigint, live_cursor bigint, history_cursor bigint,
  live_signature text, history_signature text,
  history_complete boolean NOT NULL DEFAULT false, history_gap boolean NOT NULL DEFAULT false,
  deferred_from bigint, deferred_to bigint,
  scanned_count bigint NOT NULL DEFAULT 0, deleted_count bigint NOT NULL DEFAULT 0, skipped_count bigint NOT NULL DEFAULT 0,
  connection_status text NOT NULL DEFAULT 'unknown' CHECK (connection_status IN ('connected','missing','no_access','unknown')),
  last_error text,
  next_run_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_token uuid, lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX eraser_policies_due_idx ON eraser_policies(next_run_at,chat_id) WHERE enabled;
CREATE TABLE eraser_protection_state (
  chat_id text PRIMARY KEY REFERENCES eraser_policies(chat_id),
  source_revision bigint NOT NULL DEFAULT 0,
  complete_through timestamptz,
  ready boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE eraser_protected_messages (
  chat_id text NOT NULL REFERENCES eraser_policies(chat_id), message_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('protected','hold')),
  PRIMARY KEY(chat_id,message_id)
);
CREATE TABLE eraser_protected_bots (
  chat_id text NOT NULL REFERENCES eraser_policies(chat_id), bot_id text NOT NULL,
  PRIMARY KEY(chat_id,bot_id)
);
CREATE TABLE eraser_candidates (
  chat_id text NOT NULL REFERENCES eraser_policies(chat_id), message_id text NOT NULL,
  author_id text NOT NULL, is_bot boolean, source_ms bigint NOT NULL,
  lane text NOT NULL CHECK (lane IN ('live','history')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','dispatching','uncertain','deleted','protected','review')),
  attempt_count integer NOT NULL DEFAULT 0,
  dispatch_id uuid, outcome_code text,
  next_attempt_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(chat_id,message_id)
);
CREATE INDEX eraser_candidates_due_idx ON eraser_candidates(chat_id,lane,next_attempt_at,source_ms,message_id) WHERE state='pending';
CREATE INDEX eraser_candidates_reconcile_idx ON eraser_candidates(chat_id,next_attempt_at,message_id) WHERE state IN ('dispatching','uncertain');
CREATE INDEX eraser_candidates_purge_idx ON eraser_candidates(updated_at,chat_id,message_id) WHERE state IN ('deleted','protected');
CREATE TABLE eraser_operations (
  chat_id text NOT NULL REFERENCES eraser_policies(chat_id), operation_id uuid NOT NULL,
  request_hash text NOT NULL, actor_user_id text NOT NULL,
  response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(chat_id,operation_id)
);
CREATE TABLE eraser_webhook_receipts (
  receipt_key text PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX eraser_webhook_receipts_purge_idx ON eraser_webhook_receipts(received_at,receipt_key);
CREATE INDEX eraser_candidates_active_idx ON eraser_candidates(chat_id,state,message_id) WHERE state NOT IN ('deleted','protected');

CREATE TABLE eraser_held_authors (chat_id text NOT NULL REFERENCES eraser_policies(chat_id), author_id text NOT NULL, PRIMARY KEY(chat_id,author_id));
CREATE TABLE eraser_global_held_authors (author_id text PRIMARY KEY);

CREATE TABLE eraser_global_message_holds (chat_id text NOT NULL,message_id text NOT NULL,PRIMARY KEY(chat_id,message_id));
CREATE INDEX eraser_candidates_author_effect_idx ON eraser_candidates(author_id,state) WHERE state IN ('dispatching','uncertain');
