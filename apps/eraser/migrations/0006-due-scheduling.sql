SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE eraser_policies
  ADD COLUMN normal_next_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN live_due boolean NOT NULL DEFAULT false,
  ADD COLUMN due_floor bigint,
  ADD COLUMN due_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN safety_floor bigint,
  ADD COLUMN safety_upper bigint,
  ADD COLUMN safety_cursor bigint,
  ADD COLUMN safety_signature text,
  ADD COLUMN safety_had_messages boolean NOT NULL DEFAULT false,
  ADD COLUMN safety_gap boolean NOT NULL DEFAULT false,
  ADD COLUMN safety_gap_at bigint,
  ADD COLUMN live_gap boolean NOT NULL DEFAULT false,
  ADD COLUMN live_gap_at bigint,
  ADD COLUMN live_scan_purpose text CHECK (live_scan_purpose IN ('due','safety')),
  ADD COLUMN live_scan_had_messages boolean NOT NULL DEFAULT false,
  ADD COLUMN lease_purpose text NOT NULL DEFAULT 'due' CHECK (lease_purpose IN ('due','safety')),
  ADD COLUMN safety_next_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN safety_empty_streak integer NOT NULL DEFAULT 0 CHECK (safety_empty_streak BETWEEN 0 AND 6),
  ADD COLUMN last_live_completed_at timestamptz;

-- FLAG: Legacy partial live windows lack trustworthy discovery provenance. Preserve their
-- entire uncovered range in the safety lane; legacy columns remain a conservative reader projection.
UPDATE eraser_policies SET normal_next_at=next_run_at,safety_floor=live_floor,
  safety_upper=live_upper,safety_cursor=live_cursor,safety_signature=live_signature;

-- FLAG: Older compatible workers still consume the finite combined next_run_at. Recognize
-- their scheduling writes on re-upgrade without treating a safety-only wake as ordinary work.
CREATE FUNCTION eraser_legacy_schedule_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('eraser.native_schedule',true) IS DISTINCT FROM '1'
     AND NEW.next_run_at IS DISTINCT FROM OLD.next_run_at
     AND NEW.normal_next_at IS NOT DISTINCT FROM OLD.normal_next_at
     AND NEW.safety_next_at IS NOT DISTINCT FROM OLD.safety_next_at THEN
    NEW.normal_next_at := NEW.next_run_at;
    NEW.safety_next_at := LEAST(NEW.safety_next_at,NEW.next_run_at);
    NEW.safety_floor := LEAST(NEW.safety_floor,NEW.live_floor);
    NEW.safety_upper := NULL;
    NEW.safety_cursor := NULL;
    NEW.safety_signature := NULL;
    NEW.safety_gap := false;
    NEW.due_floor := NULL;
    NEW.live_due := false;
    NEW.live_gap := false;
    NEW.due_generation := NEW.due_generation + 1;
    -- Preserve legacy live_cursor/upper/signature: the older worker must finish its own pages.
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER eraser_legacy_schedule_write BEFORE UPDATE ON eraser_policies
  FOR EACH ROW EXECUTE FUNCTION eraser_legacy_schedule_write();

CREATE TABLE eraser_future_hours (
  chat_id text NOT NULL REFERENCES eraser_policies(chat_id) ON DELETE CASCADE,
  hour_ms bigint NOT NULL CHECK (hour_ms >= 0 AND hour_ms % 3600000 = 0),
  minutes bit(60) NOT NULL,
  PRIMARY KEY(chat_id,hour_ms)
);

CREATE INDEX eraser_policies_due_ready_idx ON eraser_policies(normal_next_at,chat_id)
  WHERE enabled AND connection_status NOT IN ('missing','no_access');
CREATE INDEX eraser_policies_safety_due_idx ON eraser_policies(safety_next_at,chat_id)
  WHERE enabled AND connection_status NOT IN ('missing','no_access');

-- FLAG: Each fixed product period gets a literal immutable expression. Retained retry and pin
-- deadlines never become an age wait, and selection never sorts the full issued-retry history.
CREATE INDEX eraser_candidates_due_24_idx ON eraser_candidates
  (chat_id,lane,(GREATEST(source_ms + 86400000,CEIL(EXTRACT(EPOCH FROM (next_attempt_at AT TIME ZONE 'UTC')) * 1000)::bigint)),source_ms,message_id)
  WHERE state='pending';
CREATE INDEX eraser_candidates_due_48_idx ON eraser_candidates
  (chat_id,lane,(GREATEST(source_ms + 172800000,CEIL(EXTRACT(EPOCH FROM (next_attempt_at AT TIME ZONE 'UTC')) * 1000)::bigint)),source_ms,message_id)
  WHERE state='pending';
CREATE INDEX eraser_candidates_due_168_idx ON eraser_candidates
  (chat_id,lane,(GREATEST(source_ms + 604800000,CEIL(EXTRACT(EPOCH FROM (next_attempt_at AT TIME ZONE 'UTC')) * 1000)::bigint)),source_ms,message_id)
  WHERE state='pending';

CREATE INDEX eraser_candidates_unissued_future_idx ON eraser_candidates(chat_id,source_ms,message_id)
  WHERE state='pending' AND dispatch_id IS NULL AND attempt_count=0;
