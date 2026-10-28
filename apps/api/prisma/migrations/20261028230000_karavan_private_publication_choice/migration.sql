SET lock_timeout = '5s';
SET statement_timeout = '30s';
CREATE TABLE "karavan_marketplace_publication_choices" (
  "id" UUID NOT NULL,
  "prompt_id" UUID NOT NULL,
  "actor_max_user_id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "bot_id" TEXT NOT NULL,
  "subject_max_user_id" TEXT NOT NULL,
  "source_message_id" TEXT NOT NULL,
  "source_fingerprint" TEXT NOT NULL,
  "marketplace_id" UUID NOT NULL,
  "marketplace_name" TEXT NOT NULL,
  "binding_generation" INTEGER NOT NULL,
  "stores" JSONB NOT NULL,
  "selected_store_id" UUID,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "karavan_marketplace_publication_choices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "karavan_marketplace_choice_generation_check" CHECK ("binding_generation" > 0),
  CONSTRAINT "karavan_marketplace_choice_source_check" CHECK (length("source_message_id") BETWEEN 1 AND 200 AND length("source_fingerprint") = 64)
);
CREATE UNIQUE INDEX "karavan_marketplace_publication_choices_prompt_id_key" ON "karavan_marketplace_publication_choices"("prompt_id");
CREATE UNIQUE INDEX "karavan_marketplace_choice_actor_chat_key" ON "karavan_marketplace_publication_choices"("actor_max_user_id", "chat_id");
CREATE INDEX "karavan_marketplace_choice_expiry_idx" ON "karavan_marketplace_publication_choices"("expires_at");
