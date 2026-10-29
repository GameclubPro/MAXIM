-- FLAG: Old authority rows and their epochs remain readable after replacement.
ALTER TABLE stats_authorities
  ADD COLUMN superseded_by uuid,
  ADD COLUMN superseded_at timestamptz(6),
  ADD CONSTRAINT stats_authorities_successor_state_check CHECK (
    (superseded_by IS NULL AND superseded_at IS NULL)
    OR (superseded_by IS NOT NULL AND superseded_at IS NOT NULL
      AND superseded_by <> id AND state = 'REVOKED')
  ) NOT VALID,
  ADD CONSTRAINT stats_authorities_superseded_by_fkey FOREIGN KEY (superseded_by)
    REFERENCES stats_authorities(id) ON DELETE NO ACTION ON UPDATE NO ACTION
    DEFERRABLE INITIALLY DEFERRED NOT VALID;

ALTER TABLE stats_authorities VALIDATE CONSTRAINT stats_authorities_successor_state_check;
ALTER TABLE stats_authorities VALIDATE CONSTRAINT stats_authorities_superseded_by_fkey;

CREATE FUNCTION protect_statistics_authority_successor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- FLAG: Neither a delayed ATTEST nor an old native UPSERT may revive a terminal identity.
  IF OLD.superseded_by IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Superseded statistics authority is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER statistics_authority_successor_immutable BEFORE UPDATE ON stats_authorities
  FOR EACH ROW EXECUTE FUNCTION protect_statistics_authority_successor();
