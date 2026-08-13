ALTER TABLE "moderation_delete_intents"
ADD COLUMN "commercial_ocr_guard_required" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "commercial_ocr_deadline_at" TIMESTAMP(3);

UPDATE "moderation_delete_intents" intent
SET
  "commercial_ocr_guard_required" = true,
  "commercial_ocr_deadline_at" = intent."retry_until_at"
WHERE EXISTS (
  SELECT 1
  FROM "moderation_delete_intent_reasons" reason
  WHERE reason."intent_id" = intent."id"
    AND reason."rule_code" = 'COMMERCIAL_OCR_DELETE'
);
