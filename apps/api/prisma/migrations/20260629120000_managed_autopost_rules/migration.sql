DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ManagedAutopostRuleStatus') THEN
    CREATE TYPE "ManagedAutopostRuleStatus" AS ENUM (
      'ACTIVE',
      'PAUSED',
      'COMPLETED',
      'ERROR',
      'DISABLED'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'ManagedAutopostMaterializationStatus'
  ) THEN
    CREATE TYPE "ManagedAutopostMaterializationStatus" AS ENUM (
      'PENDING',
      'CREATED',
      'FAILED',
      'CANCELED'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "managed_autopost_rules" (
  "id" TEXT NOT NULL,
  "source_chat_id" TEXT NOT NULL,
  "entity_type" "ChatEntityType" NOT NULL DEFAULT 'CHAT',
  "actor_user_id" TEXT NOT NULL,
  "status" "ManagedAutopostRuleStatus" NOT NULL DEFAULT 'ACTIVE',
  "title" TEXT NOT NULL DEFAULT '',
  "payload" JSONB NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "next_materialize_at" TIMESTAMP(3),
  "last_materialized_at" TIMESTAMP(3),
  "last_error" TEXT,
  "locked_at" TIMESTAMP(3),
  "lock_token" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "managed_autopost_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "managed_autopost_rules_source_status_updated_idx"
ON "managed_autopost_rules"("source_chat_id", "entity_type", "status", "updated_at" DESC);

CREATE INDEX IF NOT EXISTS "managed_autopost_rules_status_next_materialize_idx"
ON "managed_autopost_rules"("status", "next_materialize_at");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'managed_autopost_rules_source_chat_id_fkey'
  ) THEN
    ALTER TABLE "managed_autopost_rules"
    ADD CONSTRAINT "managed_autopost_rules_source_chat_id_fkey"
    FOREIGN KEY ("source_chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "managed_autopost_materializations" (
  "id" TEXT NOT NULL,
  "rule_id" TEXT NOT NULL,
  "broadcast_id" TEXT,
  "revision" INTEGER NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "request_id" TEXT NOT NULL,
  "scheduled_at" TIMESTAMP(3) NOT NULL,
  "status" "ManagedAutopostMaterializationStatus" NOT NULL DEFAULT 'PENDING',
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "managed_autopost_materializations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "managed_autopost_materializations_rule_slot_revision_idx"
ON "managed_autopost_materializations"("rule_id", "scheduled_at", "revision");

CREATE UNIQUE INDEX IF NOT EXISTS "managed_autopost_materializations_request_id_key"
ON "managed_autopost_materializations"("request_id");

CREATE INDEX IF NOT EXISTS "managed_autopost_materializations_broadcast_id_idx"
ON "managed_autopost_materializations"("broadcast_id");

CREATE INDEX IF NOT EXISTS "managed_autopost_materializations_status_slot_idx"
ON "managed_autopost_materializations"("status", "scheduled_at");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'managed_autopost_materializations_rule_id_fkey'
  ) THEN
    ALTER TABLE "managed_autopost_materializations"
    ADD CONSTRAINT "managed_autopost_materializations_rule_id_fkey"
    FOREIGN KEY ("rule_id") REFERENCES "managed_autopost_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'managed_autopost_materializations_broadcast_id_fkey'
  ) THEN
    ALTER TABLE "managed_autopost_materializations"
    ADD CONSTRAINT "managed_autopost_materializations_broadcast_id_fkey"
    FOREIGN KEY ("broadcast_id") REFERENCES "managed_broadcasts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
