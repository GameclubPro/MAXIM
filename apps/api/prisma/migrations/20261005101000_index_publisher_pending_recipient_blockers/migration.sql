SET lock_timeout = '5s';
SET statement_timeout = '1800s';

CREATE INDEX CONCURRENTLY "managed_broadcast_deliveries_pub_pending_blocker_idx"
ON "managed_broadcast_deliveries" ("publication_occurrence_id")
WHERE "dispatch_profile" = 'PUBLIK_V1'
  AND "status" IN ('PENDING', 'SENDING')
  AND "dispatch_blocker_code" IS NOT NULL;

RESET statement_timeout;
RESET lock_timeout;
