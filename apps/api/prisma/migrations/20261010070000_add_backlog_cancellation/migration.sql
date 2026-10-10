-- FLAG: Cancellation records operator intent, never successful or absent effects.
-- Retain original receipts/claims; exact source and child tombstones survive retention.
ALTER TYPE "WebhookStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
CREATE TABLE "webhook_backlog_cancellations" (
  "id" TEXT PRIMARY KEY,
  "cutoff" TIMESTAMP(3) NOT NULL,
  "source_sha" TEXT NOT NULL CHECK ("source_sha" ~ '^[a-f0-9]{40}$'),
  "image_id" TEXT NOT NULL CHECK ("image_id" ~ '^sha256:[a-f0-9]{64}$'),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sealed_at" TIMESTAMP(3),
  CHECK ("cutoff" < "created_at")
);
CREATE TABLE "webhook_backlog_receipts" (
  "receipt_id" TEXT PRIMARY KEY,
  "cancellation_id" TEXT NOT NULL REFERENCES "webhook_backlog_cancellations"("id") ON DELETE RESTRICT,
  "semantic_key" TEXT,
  "chat_id" TEXT,
  "message_id" TEXT,
  "original_snapshot" JSONB NOT NULL CHECK (jsonb_typeof("original_snapshot") = 'object'),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (("chat_id" IS NULL) = ("message_id" IS NULL))
);
CREATE INDEX "webhook_backlog_receipts_semantic_idx" ON "webhook_backlog_receipts"("semantic_key");
CREATE INDEX "webhook_backlog_receipts_message_idx" ON "webhook_backlog_receipts"("chat_id", "message_id");
CREATE INDEX "webhook_backlog_receipts_operation_idx" ON "webhook_backlog_receipts"("cancellation_id", "receipt_id");
CREATE TABLE "webhook_backlog_children" (
  "kind" TEXT NOT NULL CHECK ("kind" IN ('MAX_ACTION', 'SPAMMER_OBSERVATION')),
  "child_key" TEXT NOT NULL,
  "cancellation_id" TEXT NOT NULL REFERENCES "webhook_backlog_cancellations"("id") ON DELETE RESTRICT,
  "original_snapshot" JSONB NOT NULL CHECK (jsonb_typeof("original_snapshot") = 'object'),
  PRIMARY KEY ("kind", "child_key")
);
CREATE FUNCTION "guard_backlog_cancellation_evidence"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'webhook_backlog_cancellations' AND TG_OP = 'UPDATE' THEN
    IF OLD."sealed_at" IS NOT NULL OR NEW."sealed_at" IS NULL OR
      (to_jsonb(NEW) - 'sealed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'sealed_at') THEN
      RAISE EXCEPTION 'Cancellation only permits one seal';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Cancellation evidence is permanent';
END $$;
CREATE TRIGGER "backlog_cancellation_evidence_guard" BEFORE UPDATE OR DELETE ON "webhook_backlog_cancellations"
  FOR EACH ROW EXECUTE FUNCTION "guard_backlog_cancellation_evidence"();
CREATE TRIGGER "backlog_receipt_evidence_guard" BEFORE UPDATE OR DELETE ON "webhook_backlog_receipts"
  FOR EACH ROW EXECUTE FUNCTION "guard_backlog_cancellation_evidence"();
CREATE TRIGGER "backlog_child_evidence_guard" BEFORE UPDATE OR DELETE ON "webhook_backlog_children"
  FOR EACH ROW EXECUTE FUNCTION "guard_backlog_cancellation_evidence"();
CREATE FUNCTION "guard_backlog_cancelled_receipt"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof "webhook_backlog_receipts"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "webhook_backlog_receipts" WHERE "receipt_id" = OLD."id") THEN
      RAISE EXCEPTION 'Cancelled receipt is permanent';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'CANCELLED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Cancelled receipt is immutable';
  END IF;
  IF NEW."status" = 'CANCELLED' THEN
    IF TG_OP = 'INSERT' THEN RAISE EXCEPTION 'Cancellation requires a persisted original'; END IF;
    SELECT r.* INTO STRICT proof FROM "webhook_backlog_receipts" r
      JOIN "webhook_backlog_cancellations" c ON c."id" = r."cancellation_id"
      WHERE r."receipt_id" = NEW."id" AND c."sealed_at" IS NOT NULL;
    IF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') OR
      (OLD."status" <> 'CANCELLED' AND proof."original_snapshot" IS DISTINCT FROM to_jsonb(OLD)) THEN
      RAISE EXCEPTION 'Cancellation must preserve original evidence';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "backlog_cancelled_receipt_guard" BEFORE INSERT OR UPDATE OR DELETE ON "webhook_events"
  FOR EACH ROW EXECUTE FUNCTION "guard_backlog_cancelled_receipt"();
CREATE FUNCTION "guard_backlog_cancelled_claim"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "webhook_backlog_receipts" WHERE "receipt_id" = OLD."webhook_event_id") OR
    EXISTS (SELECT 1 FROM "webhook_backlog_receipts" WHERE "semantic_key" = OLD."semantic_key") THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Cancelled execution evidence is permanent'; END IF;
    IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Cancelled execution evidence is immutable'; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "backlog_cancelled_claim_guard" BEFORE UPDATE OR DELETE ON "webhook_execution_claims"
  FOR EACH ROW EXECUTE FUNCTION "guard_backlog_cancelled_claim"();
COMMIT;
