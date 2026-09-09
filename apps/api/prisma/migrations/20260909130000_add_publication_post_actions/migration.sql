SET lock_timeout = '5s';
SET statement_timeout = '30s';

CREATE TYPE "PublicationPostActionStatus" AS ENUM ('NONE', 'PENDING', 'RUNNING', 'DONE', 'FAILED', 'AMBIGUOUS', 'SKIPPED');

ALTER TABLE "publication_content_revisions"
  ADD COLUMN "post_publish" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "managed_broadcast_deliveries"
  ADD COLUMN "post_actions_next_at" TIMESTAMP(3),
  ADD COLUMN "post_actions_token" TEXT,
  ADD COLUMN "pin_status" "PublicationPostActionStatus" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "pin_error" TEXT,
  ADD COLUMN "pin_attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "delete_status" "PublicationPostActionStatus" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "delete_at" TIMESTAMP(3),
  ADD COLUMN "deleted_at" TIMESTAMP(3),
  ADD COLUMN "delete_error" TEXT,
  ADD COLUMN "delete_attempt_count" INTEGER NOT NULL DEFAULT 0;

SET statement_timeout = '10min';
CREATE INDEX CONCURRENTLY "managed_broadcast_deliveries_post_actions_due_idx"
  ON "managed_broadcast_deliveries" ("dispatch_profile", "status", "post_actions_next_at", "id");
