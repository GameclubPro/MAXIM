CREATE INDEX CONCURRENTLY "chat_report_cases_chat_counter_idx"
  ON "chat_report_cases" ("chat_id", "counter_message_id");
CREATE INDEX CONCURRENTLY "chat_report_cases_status_due_idx"
  ON "chat_report_cases" ("status", "due_at", "id");
CREATE INDEX CONCURRENTLY "chat_report_cases_chat_status_created_idx"
  ON "chat_report_cases" ("chat_id", "status", "created_at" DESC, "id" DESC);
CREATE INDEX CONCURRENTLY "chat_report_cases_chat_author_created_idx"
  ON "chat_report_cases" ("chat_id", "author_id", "created_at" DESC, "id" DESC);
CREATE INDEX CONCURRENTLY "chat_report_cases_chat_author_status_created_idx"
  ON "chat_report_cases" ("chat_id", "author_id", "status", "created_at" DESC, "id" DESC);
CREATE INDEX CONCURRENTLY "chat_report_cases_archive_expiry_idx"
  ON "chat_report_cases" ("details_archive_completed_at", "expires_at", "id");
CREATE INDEX CONCURRENTLY "chat_report_votes_archive_page_idx"
  ON "chat_report_votes" ("case_id", "id");
CREATE INDEX CONCURRENTLY "chat_report_actions_archive_page_idx"
  ON "chat_report_actions" ("case_id", "id");
CREATE INDEX CONCURRENTLY "moderation_delete_reasons_report_case_idx"
  ON "moderation_delete_intent_reasons" ((metadata->>'reportCaseId'), "intent_id")
  WHERE rule_code IN ('PARTICIPANT_REPORT_DELETE', 'PARTICIPANT_REPORT_COMMAND_CLEANUP', 'PARTICIPANT_REPORT_COUNTER_CLEANUP');
