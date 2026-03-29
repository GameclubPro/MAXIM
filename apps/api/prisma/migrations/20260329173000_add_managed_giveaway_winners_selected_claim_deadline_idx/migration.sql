-- Improves the hot expiry scan that only considers selected winners with active claim windows.
CREATE INDEX "managed_giveaway_winners_selected_claim_deadline_idx"
ON "managed_giveaway_winners"("claim_deadline_at", "selected_at")
WHERE "status" = 'SELECTED' AND "claim_deadline_at" IS NOT NULL;
