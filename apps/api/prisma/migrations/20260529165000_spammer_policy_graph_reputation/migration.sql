CREATE TABLE IF NOT EXISTS "spammer_graph_signals" (
  "id" TEXT NOT NULL,
  "signal_key" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "chat_id" TEXT,
  "message_id" TEXT,
  "signal_type" TEXT NOT NULL,
  "signal_hash" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "score" DOUBLE PRECISION NOT NULL,
  "evidence" JSONB,
  "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "spammer_graph_signals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "spammer_graph_signals_signal_key_key"
ON "spammer_graph_signals"("signal_key");

CREATE INDEX IF NOT EXISTS "spammer_graph_signals_type_hash_expires_idx"
ON "spammer_graph_signals"("signal_type", "signal_hash", "expires_at");

CREATE INDEX IF NOT EXISTS "spammer_graph_signals_user_expires_idx"
ON "spammer_graph_signals"("user_id", "expires_at");

CREATE TABLE IF NOT EXISTS "global_spammer_enforcement_decisions" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "chat_id" TEXT,
  "message_id" TEXT,
  "trigger" TEXT NOT NULL,
  "registry_status" TEXT NOT NULL,
  "decision" TEXT NOT NULL,
  "enforcement_mode" TEXT NOT NULL,
  "delete_spammers_enabled" BOOLEAN NOT NULL,
  "admin_exempt" BOOLEAN NOT NULL DEFAULT false,
  "shadow" BOOLEAN NOT NULL DEFAULT false,
  "would_enforce" BOOLEAN NOT NULL DEFAULT false,
  "enforced" BOOLEAN NOT NULL DEFAULT false,
  "confidence_score" DOUBLE PRECISION,
  "reason" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3),
  "source_breakdown" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "global_spammer_enforcement_decisions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "global_spammer_enforcement_decisions_user_created_idx"
ON "global_spammer_enforcement_decisions"("user_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "global_spammer_enforcement_decisions_chat_created_idx"
ON "global_spammer_enforcement_decisions"("chat_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "global_spammer_enforcement_decisions_shadow_created_idx"
ON "global_spammer_enforcement_decisions"("shadow", "created_at" DESC);
