-- FLAG: Serialize against old consent writers before extending the context boundary.
BEGIN;
LOCK TABLE marketplace_button_policies, marketplace_button_contexts IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE marketplace_policy_requests IN SHARE ROW EXCLUSIVE MODE NOWAIT;
ALTER TABLE marketplace_button_contexts DROP CONSTRAINT marketplace_button_contexts_context_check;
ALTER TABLE marketplace_button_contexts ADD CONSTRAINT marketplace_button_contexts_context_check
  CHECK (context IN ('GREETINGS','MODERATION_NOTICES','CHANNEL_POSTS','PUBLICATIONS',
    'LINKS','PROFANITY','COMMERCIAL','DUPLICATES','MESSAGE_LIMITS','STOP_WORDS',
    'PHONE_NUMBERS','REQUIRED_SUBSCRIPTION','INVITATION_ACCESS','OTHER_MODERATION',
    'NIGHT_MODE','RULES','PUBLICATION','VK_IMPORT','APPROVED_SUGGESTION')) NOT VALID;
CREATE TABLE marketplace_button_captions (
  entity_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('CHAT','CHANNEL')),
  caption text NOT NULL CHECK (length(caption) BETWEEN 1 AND 48),
  revision integer NOT NULL DEFAULT 0 CHECK (revision>=0),
  PRIMARY KEY(entity_id,kind)
);
-- FLAG: Individual settings retire the legacy aggregate to false. An old
-- runtime cannot ignore a module opt-out. Old group-off writes must still revoke
-- every child, including when the legacy aggregate was already false.
CREATE FUNCTION maxim_marketplace_button_group_off() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.enabled=false AND NEW.context IN ('MODERATION_NOTICES','PUBLICATIONS') THEN
    UPDATE marketplace_button_contexts SET enabled=false,public_url=NULL,verified_until=NULL,lease_id=NULL,lease_until=NULL
    WHERE policy_id=NEW.policy_id AND context=ANY(CASE WHEN NEW.context='PUBLICATIONS'
      THEN ARRAY['PUBLICATION','VK_IMPORT','APPROVED_SUGGESTION']
      ELSE ARRAY['LINKS','PROFANITY','COMMERCIAL','DUPLICATES','MESSAGE_LIMITS','STOP_WORDS',
        'PHONE_NUMBERS','REQUIRED_SUBSCRIPTION','INVITATION_ACCESS','OTHER_MODERATION','NIGHT_MODE','RULES'] END);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER marketplace_button_group_off AFTER INSERT OR UPDATE OF enabled ON marketplace_button_contexts
FOR EACH ROW EXECUTE FUNCTION maxim_marketplace_button_group_off();
-- FLAG: Pre-canonical clients persist withdrawal through their exact receipt.
-- Children remain revocable even when specialization already disabled the aggregate.
CREATE OR REPLACE FUNCTION maxim_marketplace_mirror_legacy_button_off() RETURNS trigger LANGUAGE plpgsql AS $$
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
    WHERE policy_id=target_policy AND context IN ('PUBLICATIONS','PUBLICATION','VK_IMPORT','APPROVED_SUGGESTION') AND enabled=true;
  IF FOUND THEN UPDATE marketplace_button_policies SET revision=revision+1,updated_at=now() WHERE id=target_policy; END IF;
  RETURN NEW;
END;
$$;
COMMIT;
