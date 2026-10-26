-- FLAG: Historical adopted rules can be human authored. Page exact audit actions before JSON reads.
CREATE INDEX CONCURRENTLY "audit_logs_eraser_rules_bootstrap_idx" ON "audit_logs" ("chat_id", "created_at", "id")
  WHERE "action" IN ('ADOPT_CHAT_RULES_MESSAGE', 'PUBLISH_CHAT_RULES', 'RESET_CHAT_RULES_PUBLICATION');
