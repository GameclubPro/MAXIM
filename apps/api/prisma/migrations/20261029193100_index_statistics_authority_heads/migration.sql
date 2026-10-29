-- The full legacy constraint remains until this independently built replacement is valid.
CREATE UNIQUE INDEX CONCURRENTLY stats_authorities_current_scope_key
  ON stats_authorities(issuer,role,entity_id,producer,consumer,actor_max_id,bot_ref,purpose)
  WHERE superseded_by IS NULL;
