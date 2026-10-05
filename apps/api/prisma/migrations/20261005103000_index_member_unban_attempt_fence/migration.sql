SET lock_timeout = '5s';
SET statement_timeout = '1800s';
-- FLAG: Unverified unban attempts share the member-effect fence, including unknown
-- outcomes. Keep the previous index intact for rollback and exclude terminal history.
CREATE INDEX CONCURRENTLY "max_action_ledger_member_attempt_fence_idx"
ON "max_action_ledger" ("chat_id", "user_id", "job_id")
WHERE "action_type" IN ('BAN_MEMBER', 'KICK_MEMBER', 'TRY_UNBAN_MEMBER')
  AND ("status" = 'IN_PROGRESS'::"MaxActionLedgerStatus" OR "ambiguous" = TRUE
    OR ("action_type" = 'BAN_MEMBER' AND "status" = 'SUCCEEDED'::"MaxActionLedgerStatus"));
RESET statement_timeout;
RESET lock_timeout;
