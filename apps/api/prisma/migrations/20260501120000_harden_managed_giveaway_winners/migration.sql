-- Keep historical rerolled rows, but guarantee one active winner per prize and per entry.
WITH ranked_prize_winners AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY giveaway_id, prize_id
      ORDER BY selected_at DESC, created_at DESC, id DESC
    ) AS winner_rank
  FROM managed_giveaway_winners
  WHERE status <> 'REROLLED'
)
UPDATE managed_giveaway_winners AS winner
SET
  status = 'REROLLED',
  rerolled_at = COALESCE(winner.rerolled_at, NOW())
FROM ranked_prize_winners AS ranked
WHERE winner.id = ranked.id
  AND ranked.winner_rank > 1;

WITH ranked_entry_winners AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY giveaway_id, entry_id
      ORDER BY selected_at DESC, created_at DESC, id DESC
    ) AS winner_rank
  FROM managed_giveaway_winners
  WHERE status <> 'REROLLED'
)
UPDATE managed_giveaway_winners AS winner
SET
  status = 'REROLLED',
  rerolled_at = COALESCE(winner.rerolled_at, NOW())
FROM ranked_entry_winners AS ranked
WHERE winner.id = ranked.id
  AND ranked.winner_rank > 1;

CREATE INDEX IF NOT EXISTS "managed_giveaway_winners_status_claim_deadline_at_idx"
  ON "managed_giveaway_winners"("status", "claim_deadline_at");

CREATE UNIQUE INDEX IF NOT EXISTS "managed_giveaway_winners_active_prize_key"
  ON "managed_giveaway_winners"("giveaway_id", "prize_id")
  WHERE "status" <> 'REROLLED';

CREATE UNIQUE INDEX IF NOT EXISTS "managed_giveaway_winners_active_entry_key"
  ON "managed_giveaway_winners"("giveaway_id", "entry_id")
  WHERE "status" <> 'REROLLED';
