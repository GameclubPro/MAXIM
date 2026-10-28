SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

CREATE TABLE eraser_rate_limits (
  bot_id text PRIMARY KEY CHECK (bot_id ~ '^[0-9]+$'),
  not_before timestamptz NOT NULL
);

CREATE INDEX eraser_candidates_active_source_idx
  ON eraser_candidates(chat_id,state,source_ms,message_id)
  WHERE state IN ('pending','uncertain','dispatching','review');

CREATE INDEX eraser_candidates_unissued_age_idx
  ON eraser_candidates(chat_id,source_ms,message_id)
  WHERE state='pending' AND outcome_code='not_due'
    AND dispatch_id IS NULL AND attempt_count=0;
