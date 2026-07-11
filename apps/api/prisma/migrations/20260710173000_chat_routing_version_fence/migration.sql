CREATE OR REPLACE FUNCTION bump_chat_routing_version()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.primary_bot_id IS DISTINCT FROM OLD.primary_bot_id
     OR NEW.bot_id IS DISTINCT FROM OLD.bot_id THEN
    IF NEW.routing_version IS NOT DISTINCT FROM OLD.routing_version THEN
      NEW.routing_version := OLD.routing_version + 1;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chats_bump_routing_version ON chats;

CREATE TRIGGER chats_bump_routing_version
BEFORE UPDATE OF primary_bot_id, bot_id ON chats
FOR EACH ROW
EXECUTE FUNCTION bump_chat_routing_version();
