-- FLAG: Admit all existing writers before any DDL. Never wait for an edge/receipt
-- writer while retaining the binding lock, or upgrade a lock behind an old reader.
-- A busy relation refuses the whole migration before mutation; the release gate stays closed.
BEGIN;
LOCK TABLE marketplace_bindings IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE managed_entity_access_edges, chat_membership_activity_events, marketplace_policy_requests
  IN SHARE ROW EXCLUSIVE MODE NOWAIT;

-- One setting per platform/profile, independently authorized for each presentation context.
CREATE TABLE marketplace_button_policies (
  id uuid PRIMARY KEY,
  entity_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('CHAT','CHANNEL')),
  profile text NOT NULL CHECK (profile IN ('moderation','publisher')),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT marketplace_button_policies_entity_key UNIQUE(entity_id,kind,profile)
);
CREATE TABLE marketplace_button_contexts (
  policy_id uuid NOT NULL REFERENCES marketplace_button_policies(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  profile text NOT NULL DEFAULT 'moderation' CHECK (profile IN ('moderation','publisher')),
  context text NOT NULL CHECK (context IN ('GREETINGS','MODERATION_NOTICES','CHANNEL_POSTS','PUBLICATIONS')),
  enabled boolean NOT NULL DEFAULT false,
  confirmed_by text,
  confirmed_at timestamptz(6),
  listing_id uuid,
  ownership_key text,
  binding_id uuid,
  verified_until timestamptz(6),
  public_url text,
  refresh_at timestamptz(6) NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_until timestamptz(6),
  suspended_reason text CHECK (suspended_reason IN ('PROFILE_CHANGED','ACCESS_LOST')),
  diagnostic text CHECK (diagnostic IN ('KEYBOARD_FULL')),
  PRIMARY KEY(policy_id,context)
);
CREATE INDEX marketplace_button_contexts_refresh_idx ON marketplace_button_contexts(profile,enabled,suspended_reason,refresh_at,policy_id,context);
CREATE TABLE marketplace_button_requests (
  request_id uuid PRIMARY KEY,
  policy_id uuid NOT NULL REFERENCES marketplace_button_policies(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  actor_user_id text NOT NULL,
  payload_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT now()
);
-- Legacy grants are imported lazily, under the policy lock, from the current exact
-- publication opt-in. New contexts remain off; historical bindings/receipts stay intact.

-- FLAG: A positive refresh must never erase a known loss of the administrator
-- whose earlier opt-in is still stored. No statistics or dispatch state is reset.
ALTER TABLE marketplace_bindings ADD COLUMN last_button_access_loss_at timestamptz(6);

-- FLAG: Old denial writers kept append_enabled=true. A later real attestation
-- rewrites updated_at before lazy import, so a marker alone cannot fence that grant.
-- Seed only persisted current denials; retained events/statistics/receipts are untouched.
WITH known_loss AS MATERIALIZED (
  SELECT b.id, GREATEST(
    CASE WHEN b.state='REVOKED' THEN COALESCE(b.checked_at,b.updated_at) END,
    (SELECT max(a.checked_at AT TIME ZONE 'UTC') FROM managed_entity_access_edges a
      WHERE a.chat_id=b.entity_id AND a.user_id=b.actor_user_id
        AND (a.state='USER_DENIED' OR (a.state='GRANTED' AND a.user_role='MEMBER')))
  ) AS lost_at
  FROM marketplace_bindings b
)
UPDATE marketplace_bindings b
SET last_button_access_loss_at=GREATEST(b.last_button_access_loss_at,known_loss.lost_at),
    append_enabled=false,public_verified_until=NULL
FROM known_loss WHERE b.id=known_loss.id AND known_loss.lost_at IS NOT NULL;

CREATE FUNCTION maxim_marketplace_remember_button_access_loss() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'marketplace_bindings' THEN
    IF TG_OP = 'UPDATE' THEN
      NEW.last_button_access_loss_at := GREATEST(OLD.last_button_access_loss_at, NEW.last_button_access_loss_at);
    END IF;
    IF NEW.state = 'REVOKED' THEN
      NEW.last_button_access_loss_at := GREATEST(NEW.last_button_access_loss_at, NEW.checked_at, clock_timestamp());
      NEW.append_enabled := false;
      NEW.public_verified_until := NULL;
    END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME = 'managed_entity_access_edges' THEN
    IF NEW.state = 'USER_DENIED' OR (NEW.state = 'GRANTED' AND NEW.user_role = 'MEMBER') THEN
      UPDATE marketplace_bindings SET last_button_access_loss_at=GREATEST(last_button_access_loss_at, NEW.checked_at AT TIME ZONE 'UTC'),append_enabled=false,public_verified_until=NULL
        WHERE actor_user_id=NEW.user_id AND entity_id=NEW.chat_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'chat_membership_activity_events' THEN
    IF NEW.event_type = 'user_removed' THEN
      UPDATE marketplace_bindings SET last_button_access_loss_at=GREATEST(last_button_access_loss_at, NEW.event_at AT TIME ZONE 'UTC'),append_enabled=false,public_verified_until=NULL
        WHERE actor_user_id=NEW.user_id AND entity_id=NEW.chat_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER marketplace_button_binding_loss BEFORE INSERT OR UPDATE OF state,checked_at ON marketplace_bindings
FOR EACH ROW EXECUTE FUNCTION maxim_marketplace_remember_button_access_loss();
CREATE TRIGGER marketplace_button_user_loss AFTER INSERT OR UPDATE OF state,user_role,checked_at ON managed_entity_access_edges
FOR EACH ROW EXECUTE FUNCTION maxim_marketplace_remember_button_access_loss();
CREATE TRIGGER marketplace_button_membership_loss AFTER INSERT ON chat_membership_activity_events
FOR EACH ROW EXECUTE FUNCTION maxim_marketplace_remember_button_access_loss();

-- FLAG: Old admin roles can finish an already-open miniapp toggle while the
-- new readers are rolling out. Only its exact durable off intent fences the
-- canonical publication context; statistics withdrawal is a separate policy.
CREATE FUNCTION maxim_marketplace_mirror_legacy_button_off() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  next_revision bigint;
  canonical text;
  target_policy uuid;
BEGIN
  IF NEW.result #>> '{binding,id}' IS DISTINCT FROM NEW.binding_id::text
    OR NEW.result -> 'appendEnabled' IS DISTINCT FROM 'false'::jsonb
    OR jsonb_typeof(NEW.result -> 'appendRevision') IS DISTINCT FROM 'number'
    OR (NEW.result ->> 'appendRevision') !~ '^[1-9][0-9]{0,9}$' THEN RETURN NEW; END IF;
  next_revision := (NEW.result ->> 'appendRevision')::bigint;
  IF next_revision > 2147483647 THEN RETURN NEW; END IF;
  canonical := '{"bindingId":' || to_json(NEW.binding_id::text)::text
    || ',"action":"toggle","requestId":' || to_json(NEW.request_id::text)::text
    || ',"expectedRevision":' || (next_revision - 1)::text || ',"appendEnabled":false}';
  IF NEW.payload_hash IS DISTINCT FROM encode(sha256(convert_to(canonical, 'UTF8')), 'hex') THEN RETURN NEW; END IF;
  SELECT p.id INTO target_policy FROM marketplace_button_policies p JOIN marketplace_bindings b
    ON b.entity_id=p.entity_id AND b.kind=p.kind AND b.profile=p.profile
    WHERE b.id=NEW.binding_id FOR UPDATE OF p;
  IF target_policy IS NULL THEN RETURN NEW; END IF;
  UPDATE marketplace_button_contexts SET enabled=false,verified_until=NULL,public_url=NULL,lease_id=NULL,lease_until=NULL
    WHERE policy_id=target_policy AND context='PUBLICATIONS' AND enabled=true;
  IF FOUND THEN UPDATE marketplace_button_policies SET revision=revision+1,updated_at=now() WHERE id=target_policy; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER marketplace_button_legacy_off AFTER INSERT ON marketplace_policy_requests
FOR EACH ROW EXECUTE FUNCTION maxim_marketplace_mirror_legacy_button_off();
COMMIT;
