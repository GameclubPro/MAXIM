-- FLAG: Blind review ordering and cursors must not disclose score-derived priority.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "commercial_review_samples_blind_queue_idx"
  ON "commercial_review_samples"("observed_at" DESC, "id" DESC);
