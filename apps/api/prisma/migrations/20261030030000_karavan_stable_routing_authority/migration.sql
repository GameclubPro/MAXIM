-- FLAG: Operational route cache refreshes are not changes of the selected moderator.
-- Constant/default and nullable additions are metadata-only; legacy witnesses retain
-- their routing_version check until an explicit fresh binding records the new epoch.
ALTER TABLE "chats" ADD COLUMN "commerce_routing_epoch" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "karavan_marketplace_binding_witnesses" ADD COLUMN "routing_authority_epoch" INTEGER;

CREATE FUNCTION advance_karavan_chat_routing_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.commerce_routing_epoch := OLD.commerce_routing_epoch + CASE WHEN
    COALESCE(NEW.fixed_moderator_bot_id, NEW.primary_bot_id, NEW.bot_id)
      IS DISTINCT FROM COALESCE(OLD.fixed_moderator_bot_id, OLD.primary_bot_id, OLD.bot_id)
    OR NEW.entity_type IS DISTINCT FROM OLD.entity_type
    THEN 1 ELSE 0 END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER karavan_chat_routing_epoch
BEFORE UPDATE ON "chats"
FOR EACH ROW EXECUTE FUNCTION advance_karavan_chat_routing_epoch();
