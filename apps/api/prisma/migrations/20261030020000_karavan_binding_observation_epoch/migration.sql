-- FLAG: Successful live probes refresh evidence; only real lifecycle/access loss
-- advances the durable revocation epoch. A later live probe must not erase bot_added.
-- Function replacement is metadata-only; no table scan or existing-row rewrite.
CREATE OR REPLACE FUNCTION advance_karavan_bot_revocation_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.commerce_revocation_epoch := OLD.commerce_revocation_epoch + CASE WHEN
    (NEW.status <> 'ACTIVE' AND NEW.status IS DISTINCT FROM OLD.status)
    OR (NEW.bot_access_state IN ('DENIED','LOST') AND NEW.bot_access_state IS DISTINCT FROM OLD.bot_access_state)
    OR (NEW.lifecycle_event_at IS NOT NULL
      AND NEW.lifecycle_event_at IS DISTINCT FROM OLD.lifecycle_event_at
      AND (NEW.lifecycle_event_type IS DISTINCT FROM 'live_probe'
        OR NEW.lifecycle_source IS DISTINCT FROM 'live_probe'))
    THEN 1 ELSE 0 END;
  RETURN NEW;
END;
$$;
