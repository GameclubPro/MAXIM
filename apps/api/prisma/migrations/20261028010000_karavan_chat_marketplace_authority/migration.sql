-- Independent opt-in marketplace protocol; no existing chat or grant is changed.
CREATE TABLE "karavan_marketplace_authority_grants" (
  "id" UUID NOT NULL,
  "actor_max_user_id" TEXT NOT NULL,
  "command_id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "bot_id" TEXT NOT NULL,
  "proof_hash" TEXT NOT NULL,
  "scope_hash" TEXT NOT NULL,
  "scope" JSONB NOT NULL,
  "authority_epoch" TEXT NOT NULL,
  "chat_title" TEXT,
  "principal" JSONB NOT NULL,
  "checked_at" TIMESTAMPTZ(3) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "karavan_marketplace_authority_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "karavan_marketplace_authority_expiry_check" CHECK ("expires_at">"checked_at" AND "expires_at"<="checked_at"+INTERVAL '60 seconds'),
  CONSTRAINT "karavan_marketplace_authority_actor_command_key" UNIQUE ("actor_max_user_id", "command_id"),
  CONSTRAINT "karavan_marketplace_authority_grants_proof_hash_key" UNIQUE ("proof_hash")
);
CREATE INDEX "karavan_marketplace_authority_expiry_idx" ON "karavan_marketplace_authority_grants"("expires_at");
CREATE TABLE "karavan_marketplace_handoffs" (
  "id" UUID NOT NULL,
  "actor_max_user_id" TEXT NOT NULL,
  "command_id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "bot_id" TEXT NOT NULL,
  "marketplace_id" UUID NOT NULL,
  "destination" TEXT NOT NULL,
  "code_hash" TEXT NOT NULL,
  "authority_epoch" TEXT NOT NULL,
  "principal" JSONB NOT NULL,
  "checked_at" TIMESTAMPTZ(3) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "exchange_id" UUID,
  "exchanged_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "karavan_marketplace_handoffs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "karavan_marketplace_handoff_expiry_check" CHECK ("expires_at">"checked_at" AND "expires_at"<="checked_at"+INTERVAL '120 seconds'),
  CONSTRAINT "karavan_marketplace_handoff_exchange_pair_check" CHECK (("exchange_id" IS NULL)=("exchanged_at" IS NULL)),
  CONSTRAINT "karavan_marketplace_handoff_actor_command_key" UNIQUE ("actor_max_user_id", "command_id"),
  CONSTRAINT "karavan_marketplace_handoffs_code_hash_key" UNIQUE ("code_hash")
);
CREATE INDEX "karavan_marketplace_handoff_expiry_idx" ON "karavan_marketplace_handoffs"("expires_at");
CREATE TABLE "karavan_marketplace_connection_operations" (
  "anchor_chat_id" TEXT NOT NULL,
  "active_scope_key" TEXT,
  "id" UUID NOT NULL,
  "actor_max_user_id" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "request" JSONB NOT NULL,
  "checkpoints" JSONB NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "lease_id" UUID,
  "lease_until" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "karavan_marketplace_connection_operations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "karavan_marketplace_operation_state_check" CHECK ("state" IN ('pending','partial','complete','unknown','rejected')),
  CONSTRAINT "karavan_marketplace_operation_active_scope_key" UNIQUE ("active_scope_key"),
  CONSTRAINT "karavan_marketplace_operation_active_scope_check" CHECK (("state" IN ('pending','partial','unknown')) = ("active_scope_key" IS NOT NULL) AND ("active_scope_key" IS NULL OR "active_scope_key" = "actor_max_user_id" || ':' || "anchor_chat_id")),
  CONSTRAINT "karavan_marketplace_operation_lease_pair_check" CHECK (("lease_id" IS NULL)=("lease_until" IS NULL))
);
CREATE INDEX "karavan_marketplace_operation_actor_idx" ON "karavan_marketplace_connection_operations"("actor_max_user_id", "created_at");
-- Constant default is metadata-only on supported PostgreSQL; existing callers stay compatible.
ALTER TABLE "chat_bot_memberships" ADD COLUMN "commerce_revocation_epoch" INTEGER NOT NULL DEFAULT 0;
CREATE FUNCTION advance_karavan_bot_revocation_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.commerce_revocation_epoch := OLD.commerce_revocation_epoch + CASE WHEN
    (NEW.status <> 'ACTIVE' AND NEW.status IS DISTINCT FROM OLD.status)
    OR (NEW.bot_access_state IN ('DENIED','LOST') AND NEW.bot_access_state IS DISTINCT FROM OLD.bot_access_state)
    THEN 1 ELSE 0 END;
  RETURN NEW;
END;
$$;
CREATE TRIGGER karavan_bot_revocation_epoch BEFORE UPDATE ON "chat_bot_memberships"
FOR EACH ROW EXECUTE FUNCTION advance_karavan_bot_revocation_epoch();
CREATE TABLE "karavan_marketplace_binding_witnesses" (
  "authority_epoch" TEXT NOT NULL,
  "checked_at" TIMESTAMPTZ(3) NOT NULL,
  "chat_id" TEXT NOT NULL,
  "bot_id" TEXT NOT NULL,
  "routing_version" INTEGER NOT NULL,
  "bot_revocation_epoch" INTEGER NOT NULL,
  "revoked_at" TIMESTAMPTZ(3),
  "lifecycle_event_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "karavan_marketplace_binding_witnesses_pkey" PRIMARY KEY ("authority_epoch", "checked_at")
);
CREATE INDEX "karavan_marketplace_binding_witness_chat_bot_idx" ON "karavan_marketplace_binding_witnesses"("chat_id", "bot_id");
CREATE TABLE "karavan_marketplace_chat_enrollments" (
  "chat_id" TEXT NOT NULL,
  "phase" TEXT NOT NULL DEFAULT 'pending',
  "actor_max_user_id" TEXT NOT NULL,
  "requested_command_id" TEXT NOT NULL,
  "marketplace_id" UUID NOT NULL,
  "confirmed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "karavan_marketplace_chat_enrollments_pkey" PRIMARY KEY ("chat_id"),
  CONSTRAINT "karavan_marketplace_enrollment_phase_check" CHECK ("phase" IN ('pending','connected'))
);
