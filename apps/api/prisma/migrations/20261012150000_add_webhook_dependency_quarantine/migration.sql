ALTER TYPE "WebhookStatus" ADD VALUE IF NOT EXISTS 'QUARANTINED';

CREATE TABLE "webhook_dependency_quarantines" (
  "receipt_id" TEXT NOT NULL,
  "blocker_id" TEXT NOT NULL,
  "anchor_id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "original_status" "WebhookStatus" NOT NULL,
  "deadline_at" TIMESTAMP(3) NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'WAITING',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "next_check_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMP(3),
  CONSTRAINT "webhook_dependency_quarantines_pkey" PRIMARY KEY ("receipt_id", "blocker_id"),
  CONSTRAINT "webhook_dependency_quarantines_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "webhook_events"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "webhook_dependency_quarantines_anchor_id_fkey" FOREIGN KEY ("anchor_id") REFERENCES "webhook_events"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "webhook_dependency_quarantines_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "webhook_events"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE INDEX "webhook_dependency_quarantines_due_idx" ON "webhook_dependency_quarantines"("state", "next_check_at", "receipt_id", "blocker_id");
CREATE INDEX "webhook_dependency_quarantines_blocker_idx" ON "webhook_dependency_quarantines"("blocker_id");
CREATE INDEX "webhook_dependency_quarantines_age_idx" ON "webhook_dependency_quarantines"("state", "created_at", "receipt_id");
CREATE INDEX "webhook_dependency_quarantines_anchor_idx" ON "webhook_dependency_quarantines"("anchor_id");
