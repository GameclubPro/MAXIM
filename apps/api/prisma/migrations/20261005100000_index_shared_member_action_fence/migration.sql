SET lock_timeout = '5s';
SET statement_timeout = '1800s';
-- FLAG: Retained unknown member effects, including legacy bot-scoped journals, are
-- indexed separately from terminal history. Preserve failed concurrent-build receipts.
CREATE INDEX CONCURRENTLY "max_action_ledger_member_effect_fence_idx"
ON "max_action_ledger" ("chat_id", "user_id", "job_id")
WHERE "action_type" IN ('BAN_MEMBER', 'KICK_MEMBER')
  AND ("status" = 'IN_PROGRESS'::"MaxActionLedgerStatus" OR "ambiguous" = TRUE
    OR ("action_type" = 'BAN_MEMBER' AND "status" = 'SUCCEEDED'::"MaxActionLedgerStatus"));
RESET statement_timeout;
RESET lock_timeout;
