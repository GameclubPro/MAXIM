-- FLAG: Empty additive exact-source safety state. No runtime writer, global-user
-- immunity, effect reset, replay or historical backfill is introduced here.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

CREATE TABLE "webhook_source_abandonment_certificates" (
  "id" TEXT PRIMARY KEY,
  "operation" TEXT NOT NULL DEFAULT 'MODERN_SOURCE_ABANDONMENT_V1' CHECK ("operation" = 'MODERN_SOURCE_ABANDONMENT_V1'),
  "operation_version" INTEGER NOT NULL DEFAULT 1 CHECK ("operation_version" = 1),
  "source_sha" TEXT NOT NULL CHECK ("source_sha" ~ '^[0-9a-f]{40}$'),
  "image_id" TEXT NOT NULL CHECK ("image_id" ~ '^sha256:[0-9a-f]{64}$'),
  "attestation" JSONB NOT NULL CHECK (jsonb_typeof("attestation") = 'object'),
  "attestation_digest" TEXT NOT NULL CHECK ("attestation_digest" ~ '^[0-9a-f]{64}$'),
  "preview_sha256" TEXT NOT NULL CHECK ("preview_sha256" ~ '^[0-9a-f]{64}$'),
  "source_closure_sha256" TEXT NOT NULL CHECK ("source_closure_sha256" ~ '^[0-9a-f]{64}$'),
  "descendants_sha256" TEXT NOT NULL CHECK ("descendants_sha256" ~ '^[0-9a-f]{64}$'),
  "abandon_before" TIMESTAMP(3) NOT NULL,
  "expected_source_count" INTEGER NOT NULL CHECK ("expected_source_count" BETWEEN 1 AND 8),
  "expected_child_count" INTEGER NOT NULL CHECK ("expected_child_count" BETWEEN 0 AND 10000),
  "sealed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("abandon_before" <= "created_at" AND ("sealed_at" IS NULL OR "sealed_at" >= "created_at"))
);
CREATE TABLE "webhook_source_abandonments" (
  "id" TEXT PRIMARY KEY,
  "operation_version" INTEGER NOT NULL DEFAULT 1 CHECK ("operation_version" = 1),
  "certificate_id" TEXT NOT NULL REFERENCES "webhook_source_abandonment_certificates"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  "semantic_key" TEXT NOT NULL,
  "owner_webhook_event_id" TEXT NOT NULL,
  "claim_id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL CHECK (BTRIM("chat_id") <> '' AND octet_length("chat_id") <= 512),
  "message_id" TEXT NOT NULL CHECK (BTRIM("message_id") <> '' AND octet_length("message_id") <= 512),
  "subject_user_id" TEXT NOT NULL CHECK (BTRIM("subject_user_id") <> '' AND octet_length("subject_user_id") <= 512),
  "source_at" TIMESTAMP(3) NOT NULL,
  "raw_payload_digest" TEXT NOT NULL CHECK ("raw_payload_digest" ~ '^[0-9a-f]{64}$'),
  "normalized_payload_digest" TEXT NOT NULL CHECK ("normalized_payload_digest" ~ '^[0-9a-f]{64}$'),
  "owner_snapshot" JSONB NOT NULL CHECK (jsonb_typeof("owner_snapshot") = 'object'),
  "claim_snapshot" JSONB NOT NULL CHECK (jsonb_typeof("claim_snapshot") = 'object'),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "webhook_source_abandonments_semantic_key" ON "webhook_source_abandonments"("semantic_key");
CREATE UNIQUE INDEX "webhook_source_abandonments_owner_key" ON "webhook_source_abandonments"("owner_webhook_event_id");
CREATE UNIQUE INDEX "webhook_source_abandonments_claim_key" ON "webhook_source_abandonments"("claim_id");
CREATE UNIQUE INDEX "webhook_source_abandonments_chat_message_key" ON "webhook_source_abandonments"("chat_id", "message_id");
CREATE INDEX "webhook_source_abandonments_certificate_idx" ON "webhook_source_abandonments"("certificate_id");
CREATE TABLE "webhook_source_child_holds" (
  "abandonment_id" TEXT NOT NULL REFERENCES "webhook_source_abandonments"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('MAX_ACTION', 'SPAMMER_OBSERVATION')),
  "child_key" TEXT NOT NULL CHECK (BTRIM("child_key") <> '' AND octet_length("child_key") <= 512),
  "payload_digest" TEXT NOT NULL CHECK ("payload_digest" ~ '^[0-9a-f]{64}$'),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("abandonment_id", "kind", "child_key")
);
CREATE INDEX "webhook_source_child_holds_kind_key_idx" ON "webhook_source_child_holds"("kind", "child_key");
CREATE TABLE "webhook_source_receipt_dispositions" (
  "id" TEXT PRIMARY KEY,
  "receipt_id" TEXT NOT NULL,
  "abandonment_id" TEXT NOT NULL REFERENCES "webhook_source_abandonments"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  "source_digest" TEXT NOT NULL CHECK ("source_digest" ~ '^[0-9a-f]{64}$'),
  "original_status" "WebhookStatus" NOT NULL CHECK ("original_status" NOT IN ('PROCESSED', 'DUPLICATE', 'NO_REPLAY_HELD')),
  "original_snapshot" JSONB NOT NULL CHECK (jsonb_typeof("original_snapshot") = 'object'),
  "scope_kind" TEXT NOT NULL CHECK ("scope_kind" IN ('EXACT_OWNER', 'EXACT_SOURCE')),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "webhook_source_receipt_dispositions_receipt_key" ON "webhook_source_receipt_dispositions"("receipt_id");
CREATE UNIQUE INDEX "webhook_source_receipt_dispositions_receipt_id_id_key" ON "webhook_source_receipt_dispositions"("receipt_id", "id");
CREATE INDEX "webhook_source_receipt_dispositions_abandonment_idx" ON "webhook_source_receipt_dispositions"("abandonment_id");

ALTER TABLE "webhook_events" ADD COLUMN "source_disposition_id" TEXT,
  ADD COLUMN "source_disposition_receipt_id" TEXT,
  ADD CONSTRAINT "webhook_events_source_disposition_identity_check" CHECK (
    ("source_disposition_id" IS NULL AND "source_disposition_receipt_id" IS NULL) OR
    ("source_disposition_id" IS NOT NULL AND "source_disposition_receipt_id" = "id" AND "source_disposition_receipt_id" IS NOT NULL)) NOT VALID,
  ADD CONSTRAINT "webhook_events_single_disposition_check" CHECK (
    "legacy_disposition_id" IS NULL OR "source_disposition_id" IS NULL) NOT VALID,
  ADD CONSTRAINT "webhook_events_source_disposition_fkey" FOREIGN KEY ("source_disposition_receipt_id", "source_disposition_id")
    REFERENCES "webhook_source_receipt_dispositions"("receipt_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;
ALTER TABLE "webhook_events" DROP CONSTRAINT "webhook_events_no_replay_held_proof_check";
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_no_replay_held_proof_check" CHECK (
  "status" <> 'NO_REPLAY_HELD' OR "legacy_disposition_id" IS NOT NULL OR "source_disposition_id" IS NOT NULL) NOT VALID;

-- FLAG: Hold rows remain effective before the seal; only a complete immutable seal
-- permits positive receipt projection. No source or child may be added afterward.
CREATE FUNCTION "guard_source_abandonment_certificate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Source abandonment certificate is permanent'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."sealed_at" IS NOT NULL THEN RAISE EXCEPTION 'New source certificate must be unsealed'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."sealed_at" IS NOT NULL OR NEW."sealed_at" IS NULL OR
    (to_jsonb(NEW) - 'sealed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'sealed_at') OR
    (SELECT count(*) FROM "webhook_source_abandonments" WHERE "certificate_id" = OLD."id") <> OLD."expected_source_count" OR
    (SELECT count(*) FROM "webhook_source_child_holds" h JOIN "webhook_source_abandonments" a ON a."id" = h."abandonment_id"
      WHERE a."certificate_id" = OLD."id") <> OLD."expected_child_count" THEN
    RAISE EXCEPTION 'Source certificate seal mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "source_abandonment_certificate_guard" BEFORE INSERT OR UPDATE OR DELETE ON "webhook_source_abandonment_certificates"
  FOR EACH ROW EXECUTE FUNCTION "guard_source_abandonment_certificate"();
CREATE FUNCTION "guard_source_abandonment_row"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cert_id TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Source abandonment evidence is permanent and immutable'; END IF;
  IF TG_TABLE_NAME = 'webhook_source_abandonments' THEN cert_id := NEW."certificate_id";
  ELSE SELECT "certificate_id" INTO STRICT cert_id FROM "webhook_source_abandonments" WHERE "id" = NEW."abandonment_id";
  END IF;
  PERFORM "id" FROM "webhook_source_abandonment_certificates" WHERE "id" = cert_id AND "sealed_at" IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Source hold requires exact unsealed certificate'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "source_abandonment_row_guard" BEFORE INSERT OR UPDATE OR DELETE ON "webhook_source_abandonments"
  FOR EACH ROW EXECUTE FUNCTION "guard_source_abandonment_row"();
CREATE TRIGGER "source_abandonment_child_guard" BEFORE INSERT OR UPDATE OR DELETE ON "webhook_source_child_holds"
  FOR EACH ROW EXECUTE FUNCTION "guard_source_abandonment_row"();
CREATE FUNCTION "guard_source_receipt_disposition"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Source receipt proof is permanent and immutable'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "webhook_source_abandonments" a
    JOIN "webhook_source_abandonment_certificates" c ON c."id" = a."certificate_id"
    WHERE a."id" = NEW."abandonment_id" AND a."operation_version" = 1 AND c."operation_version" = 1
      AND c."operation" = 'MODERN_SOURCE_ABANDONMENT_V1' AND c."sealed_at" IS NOT NULL
      AND ((NEW."scope_kind" = 'EXACT_OWNER' AND NEW."receipt_id" = a."owner_webhook_event_id" AND NEW."original_status" = 'FAILED')
        OR (NEW."scope_kind" = 'EXACT_SOURCE' AND NEW."receipt_id" <> a."owner_webhook_event_id"))) THEN
    RAISE EXCEPTION 'Missing exact sealed source authority';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "source_receipt_disposition_guard" BEFORE INSERT OR UPDATE OR DELETE ON "webhook_source_receipt_dispositions"
  FOR EACH ROW EXECUTE FUNCTION "guard_source_receipt_disposition"();
CREATE FUNCTION "guard_source_projected_receipt"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof "webhook_source_receipt_dispositions"%ROWTYPE;
BEGIN
  -- FLAG: Runtime validates late mirrors against the retained original body and claim.
  -- A source tombstone never substitutes invented evidence for that exact snapshot.
  IF TG_OP = 'DELETE' THEN
    IF OLD."source_disposition_id" IS NOT NULL OR EXISTS (
      SELECT 1 FROM "webhook_source_abandonments" WHERE "owner_webhook_event_id" = OLD."id") THEN
      RAISE EXCEPTION 'Source evidence receipt is permanent';
    END IF;
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM "webhook_source_abandonments" WHERE "owner_webhook_event_id" = OLD."id") AND
    (to_jsonb(NEW) - ARRAY['source_disposition_id','source_disposition_receipt_id']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['source_disposition_id','source_disposition_receipt_id']) THEN
    RAISE EXCEPTION 'Source owner evidence is immutable';
  END IF;
  IF OLD."source_disposition_id" IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Projected source receipt is immutable';
  END IF;
  IF OLD."source_disposition_id" IS NULL AND NEW."source_disposition_id" IS NOT NULL THEN
    SELECT * INTO STRICT proof FROM "webhook_source_receipt_dispositions"
      WHERE "id" = NEW."source_disposition_id" AND "receipt_id" = NEW."id";
    IF OLD."legacy_disposition_id" IS NOT NULL OR proof."original_status" <> OLD."status" OR
      (proof."scope_kind" = 'EXACT_OWNER' AND (OLD."status" <> 'FAILED' OR NEW."status" <> OLD."status")) OR
      (proof."scope_kind" = 'EXACT_SOURCE' AND NEW."status" <> 'NO_REPLAY_HELD') OR
      (to_jsonb(NEW) - ARRAY['source_disposition_id','source_disposition_receipt_id','status']) IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['source_disposition_id','source_disposition_receipt_id','status']) THEN
      RAISE EXCEPTION 'Source projection must preserve exact original evidence';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "source_projected_receipt_guard" BEFORE UPDATE OR DELETE ON "webhook_events"
  FOR EACH ROW EXECUTE FUNCTION "guard_source_projected_receipt"();
-- FLAG: Preserve the started authority independently of body-retention cascades.
CREATE FUNCTION "guard_source_execution_claim"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "webhook_source_abandonments" WHERE "claim_id" = OLD."id") THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Source execution evidence is permanent'; END IF;
    IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Source execution evidence is immutable'; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "source_execution_claim_guard" BEFORE UPDATE OR DELETE ON "webhook_execution_claims"
  FOR EACH ROW EXECUTE FUNCTION "guard_source_execution_claim"();
COMMIT;
