-- FLAG: Only positive, source-bound receipt evidence may leave the actionable queue.
-- Adding a nullable column has no table rewrite. The NOT VALID FK checks all new writes.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
CREATE TABLE "webhook_legacy_sealed_authorities" (
  "id" TEXT PRIMARY KEY,
  "certificate_id" TEXT NOT NULL UNIQUE,
  "authority_version" INTEGER NOT NULL DEFAULT 1 CHECK ("authority_version" = 1),
  "source_sha" TEXT NOT NULL CHECK ("source_sha" ~ '^[0-9a-f]{40}$'),
  "image_id" TEXT NOT NULL CHECK ("image_id" ~ '^sha256:[0-9a-f]{64}$'),
  "attestation_digest" TEXT NOT NULL CHECK ("attestation_digest" ~ '^[0-9a-f]{64}$'),
  "preview_sha256" TEXT NOT NULL CHECK ("preview_sha256" ~ '^[0-9a-f]{64}$'),
  "sealed_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "webhook_legacy_receipt_dispositions" (
  "id" TEXT PRIMARY KEY,
  "receipt_id" TEXT NOT NULL UNIQUE,
  "authority_id" TEXT NOT NULL REFERENCES "webhook_legacy_sealed_authorities"("id") ON DELETE RESTRICT,
  "reason" TEXT NOT NULL DEFAULT 'NO_REPLAY_HELD' CHECK ("reason" = 'NO_REPLAY_HELD'),
  "source_digest" TEXT NOT NULL CHECK ("source_digest" ~ '^[0-9a-f]{64}$'),
  "original_status" "WebhookStatus" NOT NULL CHECK ("original_status" <> 'NO_REPLAY_HELD'),
  "original_snapshot" JSONB NOT NULL CHECK (jsonb_typeof("original_snapshot") = 'object'),
  "scope_kind" TEXT NOT NULL CHECK ("scope_kind" IN ('EXACT_OWNER', 'PRE_SEAL_SOURCE', 'POST_SEAL_MEMBER')),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "webhook_legacy_receipt_dispositions_receipt_id_id_key" UNIQUE ("receipt_id", "id")
);
CREATE INDEX "webhook_legacy_receipt_dispositions_authority_idx" ON "webhook_legacy_receipt_dispositions"("authority_id");
ALTER TABLE "webhook_events" ADD COLUMN "legacy_disposition_id" TEXT,
  ADD COLUMN "legacy_disposition_receipt_id" TEXT,
  ADD CONSTRAINT "webhook_events_legacy_disposition_identity_check" CHECK (
    ("legacy_disposition_id" IS NULL AND "legacy_disposition_receipt_id" IS NULL)
    OR ("legacy_disposition_id" IS NOT NULL AND "legacy_disposition_receipt_id" IS NOT NULL
      AND "legacy_disposition_receipt_id" = "id")) NOT VALID,
  ADD CONSTRAINT "webhook_events_no_replay_held_proof_check" CHECK (
    "status" <> 'NO_REPLAY_HELD' OR "legacy_disposition_id" IS NOT NULL) NOT VALID;
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_legacy_disposition_receipt_id_legacy_dispos_fkey"
  FOREIGN KEY ("legacy_disposition_receipt_id", "legacy_disposition_id") REFERENCES "webhook_legacy_receipt_dispositions"("receipt_id", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;

-- FLAG: The seal is checked on insertion; an unsealed or re-bound certificate is never authority.
CREATE FUNCTION "assert_legacy_positive_authority"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Legacy positive authority is immutable'; END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "webhook_legacy_quiescence_certificates" c
    WHERE c."id" = NEW."certificate_id" AND c."authority_version" = NEW."authority_version"
      AND c."sealed_at" = NEW."sealed_at" AND c."source_sha" = NEW."source_sha"
      AND c."image_id" = NEW."image_id" AND c."attestation_digest" = NEW."attestation_digest"
      AND c."preview_sha256" = NEW."preview_sha256") THEN
    RAISE EXCEPTION 'Missing exact sealed legacy authority';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "legacy_positive_authority_guard" BEFORE INSERT OR UPDATE ON "webhook_legacy_sealed_authorities"
  FOR EACH ROW EXECUTE FUNCTION "assert_legacy_positive_authority"();
CREATE FUNCTION "assert_legacy_receipt_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Legacy receipt disposition is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "legacy_receipt_disposition_guard" BEFORE UPDATE ON "webhook_legacy_receipt_dispositions"
  FOR EACH ROW EXECUTE FUNCTION "assert_legacy_receipt_immutable"();
CREATE FUNCTION "assert_legacy_projected_receipt"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  proof "webhook_legacy_receipt_dispositions"%ROWTYPE;
BEGIN
  IF OLD."legacy_disposition_id" IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Projected legacy receipt evidence is immutable';
  END IF;
  IF OLD."legacy_disposition_id" IS NULL AND NEW."legacy_disposition_id" IS NOT NULL THEN
    SELECT * INTO STRICT proof FROM "webhook_legacy_receipt_dispositions"
      WHERE "id" = NEW."legacy_disposition_id" AND "receipt_id" = NEW."id";
    IF proof."original_status" <> OLD."status" OR
      (proof."scope_kind" = 'EXACT_OWNER' AND (OLD."status" <> 'FAILED' OR NEW."status" <> OLD."status")) OR
      (proof."scope_kind" <> 'EXACT_OWNER' AND NEW."status" <> 'NO_REPLAY_HELD') THEN
      RAISE EXCEPTION 'Legacy operational state does not match exact original evidence';
    END IF;
    IF (to_jsonb(NEW) - ARRAY['legacy_disposition_id','legacy_disposition_receipt_id','status']) IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['legacy_disposition_id','legacy_disposition_receipt_id','status']) THEN
      RAISE EXCEPTION 'Legacy projection must preserve original evidence';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "legacy_projected_receipt_guard" BEFORE UPDATE ON "webhook_events"
  FOR EACH ROW EXECUTE FUNCTION "assert_legacy_projected_receipt"();
CREATE TABLE "webhook_legacy_materialization_cursors" (
  "certificate_id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "horizon" TIMESTAMP(3) NOT NULL,
  "after_created_at" TIMESTAMP(3),
  "after_id" TEXT,
  "scanned" INTEGER NOT NULL DEFAULT 0 CHECK ("scanned" >= 0),
  "complete" BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY ("certificate_id", "chat_id"),
  CHECK (("after_created_at" IS NULL) = ("after_id" IS NULL))
);
COMMIT;
