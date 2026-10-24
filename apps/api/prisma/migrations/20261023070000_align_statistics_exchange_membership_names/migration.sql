-- FLAG: Keep existing keys, rows and object identities; only align stable Prisma metadata names.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE statistics_exchange_membership_snapshot_entities
  RENAME CONSTRAINT statistics_exchange_membership_snapshot_entiti_snapshot_id_fkey
  TO statistics_exchange_membership_snapshot_entity_snapshot_fk;
ALTER TABLE statistics_exchange_membership_snapshot_entities
  RENAME CONSTRAINT statistics_exchange_membership_s_snapshot_id_kind_entity_id_key
  TO statistics_exchange_membership_snapshot_entity_identity_key;
ALTER TABLE statistics_exchange_membership_snapshots
  RENAME CONSTRAINT statistics_exchange_membership_sna_actor_user_id_request_id_key
  TO statistics_exchange_membership_snapshot_actor_request_key;
COMMIT;
