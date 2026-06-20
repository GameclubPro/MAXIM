CREATE TYPE "ManagedEntityHandshakeOutcomeStatus" AS ENUM (
  'CONNECTED',
  'ALREADY_CONNECTED',
  'BOOTSTRAPPED_WITHOUT_USER',
  'BOT_DENIED',
  'USER_DENIED',
  'RATE_LIMITED',
  'FAILED'
);

CREATE TABLE "managed_entity_handshake_outcomes" (
  "chat_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "bot_id" TEXT NOT NULL,
  "entity_type" "ChatEntityType" NOT NULL DEFAULT 'CHAT',
  "status" "ManagedEntityHandshakeOutcomeStatus" NOT NULL,
  "reason" TEXT,
  "title" TEXT,
  "source" TEXT NOT NULL DEFAULT 'handshake_start',
  "happened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "managed_entity_handshake_outcomes_pkey" PRIMARY KEY ("chat_id", "user_id", "bot_id")
);

CREATE INDEX "managed_entity_handshake_outcomes_user_type_idx" ON "managed_entity_handshake_outcomes" ("user_id", "entity_type", "happened_at" DESC);
CREATE INDEX "managed_entity_handshake_outcomes_chat_idx" ON "managed_entity_handshake_outcomes" ("chat_id", "happened_at" DESC);
