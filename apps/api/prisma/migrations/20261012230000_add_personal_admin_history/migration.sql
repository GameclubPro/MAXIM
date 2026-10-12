BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "managed_entity_access_edges" ADD COLUMN "last_admin_confirmed_at" TIMESTAMP(3);

-- FLAG: Historical association is discovery evidence, never current authorization.
-- Capture old grants on revocation too, without a table-wide backfill or fabricated dates.
CREATE FUNCTION maxim_remember_admin_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.last_admin_confirmed_at := OLD.last_admin_confirmed_at;
    IF OLD.state = 'GRANTED' AND OLD.user_role IN ('ADMIN', 'OWNER') THEN
      NEW.last_admin_confirmed_at := GREATEST(NEW.last_admin_confirmed_at, OLD.checked_at);
    END IF;
  END IF;
  IF NEW.state = 'GRANTED' AND NEW.user_role IN ('ADMIN', 'OWNER') THEN
    NEW.last_admin_confirmed_at := GREATEST(NEW.last_admin_confirmed_at, NEW.checked_at);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER managed_entity_admin_confirmation
BEFORE INSERT OR UPDATE ON "managed_entity_access_edges"
FOR EACH ROW EXECUTE FUNCTION maxim_remember_admin_confirmation();
COMMIT;
