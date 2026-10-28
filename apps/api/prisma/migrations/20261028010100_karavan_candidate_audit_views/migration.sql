-- Narrow read-only inventory projections. No message text, initData, actor IDs or raw payload.
CREATE VIEW karavan_marketplace_candidate_settings WITH (security_barrier=true) AS
SELECT s.id AS settings_id, s.chat_id, c.title AS chat_title, c.entity_type::text AS entity_type,
  s.karavan_storefront_enabled AS enabled, s.karavan_storefront_admins_only AS admins_only
FROM chat_settings s LEFT JOIN chats c ON c.id=s.chat_id;

CREATE VIEW karavan_marketplace_candidate_events WITH (security_barrier=true) AS
SELECT id, chat_id, action, created_at,
  CASE WHEN action='UPDATE_SETTINGS' THEN
    coalesce(payload->'settingKeys' ? 'karavanStorefrontEnabled',false)
    OR coalesce(payload ? 'karavanStorefrontEnabled',false)
    ELSE false END AS storefront_field_touched,
  CASE WHEN action='KARAVAN_STOREFRONT_RELAY' THEN
    CASE WHEN payload->>'deliveryStatus' IN ('pending','queued','sent','ambiguous')
      THEN payload->>'deliveryStatus' ELSE 'unconfirmed' END
    ELSE NULL END AS relay_status,
  CASE WHEN action='KARAVAN_STOREFRONT_RELAY' THEN
    coalesce(payload->>'deliveryStatus'='sent' AND length(payload->>'companionMessageId')>0,false)
    ELSE false END AS relay_sent_confirmed
FROM audit_logs WHERE action IN ('UPDATE_SETTINGS','KARAVAN_STOREFRONT_RELAY');
