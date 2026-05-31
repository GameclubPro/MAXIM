ALTER TABLE "admin_global_spammer_exemptions"
  ADD COLUMN "decision" TEXT NOT NULL DEFAULT 'ALLOW';

CREATE INDEX "admin_global_spammer_exemptions_decision_updated_idx"
  ON "admin_global_spammer_exemptions" ("decision", "updated_at" DESC);
