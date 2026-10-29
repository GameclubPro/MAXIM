SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE eraser_policies
  ADD COLUMN deleted_historical_unknown_count bigint NOT NULL DEFAULT 0 CHECK (deleted_historical_unknown_count >= 0),
  ADD COLUMN deleted_acknowledged_count bigint NOT NULL DEFAULT 0 CHECK (deleted_acknowledged_count >= 0),
  ADD COLUMN deleted_removal_receipt_count bigint NOT NULL DEFAULT 0 CHECK (deleted_removal_receipt_count >= 0);

-- FLAG: Existing totals cannot prove which confirmation arrived first. Preserve that uncertainty;
-- a removal notification never establishes an external actor, including after this cutover.
UPDATE eraser_policies SET deleted_historical_unknown_count=deleted_count;

-- FLAG: A compatible older writer updates only the combined total. Keep its new confirmations
-- unclassified on rollback/re-upgrade; never fabricate ACK or receipt provenance from journal age.
CREATE FUNCTION eraser_confirmation_totals() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.deleted_historical_unknown_count := NEW.deleted_count
    - NEW.deleted_acknowledged_count - NEW.deleted_removal_receipt_count;
  RETURN NEW;
END $$;
CREATE TRIGGER eraser_confirmation_totals BEFORE INSERT OR UPDATE OF
  deleted_count,deleted_acknowledged_count,deleted_removal_receipt_count ON eraser_policies
  FOR EACH ROW EXECUTE FUNCTION eraser_confirmation_totals();

CREATE INDEX eraser_candidates_unknown_age_idx
  ON eraser_candidates(chat_id,updated_at,message_id) WHERE state='uncertain';
CREATE INDEX eraser_candidates_dispatch_deadline_idx
  ON eraser_candidates(chat_id,next_attempt_at,message_id) WHERE state='dispatching';
