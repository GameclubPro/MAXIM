ALTER TABLE "publisher_auto_reply_authoring_sessions"
  RENAME CONSTRAINT "publisher_auto_reply_sessions_target_chat_id_fkey"
  TO "publisher_auto_reply_authoring_sessions_target_chat_id_fkey";

ALTER TABLE "publisher_auto_reply_authoring_sessions"
  RENAME CONSTRAINT "publisher_auto_reply_sessions_rule_id_fkey"
  TO "publisher_auto_reply_authoring_sessions_rule_id_fkey";

ALTER TABLE "publisher_auto_reply_authoring_sessions"
  RENAME CONSTRAINT "publisher_auto_reply_sessions_content_revision_id_fkey"
  TO "publisher_auto_reply_authoring_sessions_content_revision_i_fkey";
