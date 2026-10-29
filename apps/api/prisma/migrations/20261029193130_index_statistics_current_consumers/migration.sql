-- Current consumer fanout must not scan retained terminal authority chains.
CREATE INDEX CONCURRENTLY stats_authorities_current_consumers_idx
  ON stats_authorities(entity_id,id)
  WHERE superseded_by IS NULL AND role='CONSUMER' AND issuer='EXCHANGE' AND consumer='EXCHANGE';
