-- FLAG: This internal denial survives access attestation and automatic server selections.
-- No v1 response field, publication permission, or user consent is added by this migration.
-- One transaction retains the binding DDL lock until receipt fences and backfill are installed.
BEGIN;
ALTER TABLE marketplace_bindings ADD COLUMN statistics_revoked_at TIMESTAMPTZ(6);

CREATE FUNCTION marketplace_explicit_statistics_revoke(
  binding_id UUID, request_id UUID, payload_hash TEXT, result JSONB
) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  next_revision BIGINT;
  canonical TEXT;
BEGIN
  -- The integration DELETE writer has exactly this durable result.
  IF result = '{"revoked":true}'::jsonb THEN
    RETURN true;
  END IF;
  -- A toggle/access failure can also return REVOKED/false. Only the exact revoke hash proves intent.
  IF result #>> '{binding,id}' IS DISTINCT FROM binding_id::text
    OR result #>> '{binding,state}' IS DISTINCT FROM 'REVOKED'
    OR result #> '{binding,statisticsConsent}' IS DISTINCT FROM 'false'::jsonb
    OR result -> 'appendEnabled' IS DISTINCT FROM 'false'::jsonb
    OR jsonb_typeof(result -> 'appendRevision') IS DISTINCT FROM 'number'
    OR (result ->> 'appendRevision') !~ '^[1-9][0-9]{0,9}$' THEN
    RETURN false;
  END IF;
  next_revision := (result ->> 'appendRevision')::bigint;
  IF next_revision > 2147483647 THEN RETURN false; END IF;
  canonical := '{"bindingId":' || to_json(binding_id::text)::text
    || ',"action":"revoke","requestId":' || to_json(request_id::text)::text
    || ',"expectedRevision":' || (next_revision - 1)::text || '}';
  RETURN payload_hash = encode(sha256(convert_to(canonical, 'UTF8')), 'hex');
END;
$$;

CREATE FUNCTION marketplace_statistics_revocation_fence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- FLAG: Old v2 writers do not know the marker and must not revive an explicit denial.
  -- Its only clearing writer is an explicit v1 consent with the same local policy CAS.
  IF OLD.statistics_revoked_at IS NOT NULL AND NEW.statistics_revoked_at IS NULL
    AND NOT (NEW.statistics_consent AND NOT NEW.statistics_v2_consent_only
      AND NEW.append_revision = OLD.append_revision + 1 AND NEW.revision = OLD.revision + 1) THEN
    NEW.statistics_revoked_at := OLD.statistics_revoked_at;
  END IF;
  IF NEW.statistics_revoked_at IS NOT NULL THEN
    IF OLD.statistics_revoked_at IS NULL THEN
      IF NEW.revision = OLD.revision THEN NEW.revision := OLD.revision + 1; END IF;
      IF NEW.append_revision = OLD.append_revision THEN NEW.append_revision := OLD.append_revision + 1; END IF;
    END IF;
    NEW.statistics_consent := false;
    NEW.statistics_v2_consent_only := false;
    NEW.append_enabled := false;
    NEW.public_verified_until := NULL;
    NEW.lease_id := NULL;
    NEW.lease_until := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER marketplace_statistics_revocation_fence
BEFORE UPDATE ON marketplace_bindings
FOR EACH ROW EXECUTE FUNCTION marketplace_statistics_revocation_fence();

CREATE FUNCTION marketplace_record_statistics_revocation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF marketplace_explicit_statistics_revoke(NEW.binding_id, NEW.request_id, NEW.payload_hash, NEW.result) THEN
    UPDATE marketplace_bindings SET statistics_revoked_at=COALESCE(statistics_revoked_at, NEW.created_at)
      WHERE id=NEW.binding_id;
  END IF;
  RETURN NEW;
END;
$$;

-- FLAG: Installed before the old roles stop: both old revoke transactions insert these receipts.
CREATE TRIGGER marketplace_record_statistics_revocation
AFTER INSERT ON marketplace_policy_requests
FOR EACH ROW EXECUTE FUNCTION marketplace_record_statistics_revocation();

-- Only proven historical revokes qualify. A current independent legacy true survives this repair.
WITH proven AS MATERIALIZED (
  SELECT binding_id, min(created_at) AS revoked_at FROM marketplace_policy_requests
  WHERE marketplace_explicit_statistics_revoke(binding_id, request_id, payload_hash, result)
  GROUP BY binding_id
)
UPDATE marketplace_bindings b SET statistics_revoked_at=proven.revoked_at
FROM proven WHERE b.id=proven.binding_id AND b.statistics_revoked_at IS NULL
  AND (b.statistics_consent=false OR b.statistics_v2_consent_only=true);
COMMIT;
