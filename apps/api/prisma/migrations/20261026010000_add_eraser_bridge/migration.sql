-- FLAG: Ownership is permanent. Switching a process flag off never revives the old executor.
CREATE TABLE "eraser_chat_bindings" (
  "chat_id" TEXT PRIMARY KEY,
  "legacy_hours" INTEGER NOT NULL DEFAULT 48 CHECK ("legacy_hours" IN (24, 48, 168)),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "eraser_protected_messages" (
  "chat_id" TEXT NOT NULL,
  "message_id" TEXT NOT NULL,
  "held" BOOLEAN NOT NULL DEFAULT FALSE,
  "delivered" BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("chat_id", "message_id")
);
CREATE TABLE "eraser_protection_outbox" (
  "chat_id" TEXT PRIMARY KEY,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "delivered_revision" INTEGER NOT NULL DEFAULT -1,
  "bootstrap_cursor" TEXT,
  "bootstrap_complete" BOOLEAN NOT NULL DEFAULT FALSE,
  "rules_audit_at" TIMESTAMP(3),
  "rules_audit_id" TEXT,
  "rules_audit_complete" BOOLEAN NOT NULL DEFAULT FALSE,
  "hold_cursor" TEXT,
  "holds_complete" BOOLEAN NOT NULL DEFAULT FALSE,
  "source_cursor" TEXT,
  "source_stage" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_token" TEXT,
  "lease_until" TIMESTAMP(3),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "eraser_protection_outbox_due_idx" ON "eraser_protection_outbox" ("next_attempt_at", "chat_id");
CREATE TABLE "eraser_control_operations" (
  "id" TEXT PRIMARY KEY,
  "chat_id" TEXT NOT NULL,
  "actor_user_id" TEXT NOT NULL,
  "request" JSONB NOT NULL,
  "result" JSONB,
  "confirmed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "eraser_control_operations_chat_created_idx" ON "eraser_control_operations" ("chat_id", "created_at");
CREATE TABLE "eraser_held_authors" ("author_id" TEXT PRIMARY KEY, "delivered" BOOLEAN NOT NULL DEFAULT FALSE);
CREATE INDEX "eraser_held_authors_delivery_idx" ON "eraser_held_authors" ("delivered", "author_id");
CREATE INDEX "eraser_protected_messages_delivery_idx" ON "eraser_protected_messages" ("chat_id", "delivered", "message_id");
CREATE TABLE "eraser_protected_bots" (
  "chat_id" TEXT NOT NULL,
  "bot_id" TEXT NOT NULL,
  "delivered" BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY ("chat_id", "bot_id")
);
CREATE INDEX "eraser_protected_bots_delivery_idx" ON "eraser_protected_bots" ("chat_id", "delivered", "bot_id");
CREATE TABLE "eraser_publication_fences" (
  "chat_id" TEXT NOT NULL,
  "source_key" TEXT NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("chat_id", "source_key")
);
CREATE INDEX "eraser_publication_fences_started_idx" ON "eraser_publication_fences" ("chat_id", "started_at");
CREATE TABLE "eraser_global_hold_state" (
  "id" INTEGER PRIMARY KEY CHECK (id = 1),
  "source_cursor" TEXT,
  "bootstrap_complete" BOOLEAN NOT NULL DEFAULT FALSE,
  "lease_token" TEXT,
  "lease_until" TIMESTAMP(3)
);
INSERT INTO "eraser_global_hold_state" (id) VALUES (1);

CREATE FUNCTION "eraser_mark_protection_dirty"(target_chat TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM eraser_chat_bindings WHERE chat_id = target_chat) THEN
    INSERT INTO eraser_protection_outbox(chat_id) VALUES (target_chat)
    ON CONFLICT (chat_id) DO UPDATE SET revision = eraser_protection_outbox.revision + 1,
      next_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP;
  END IF;
END $$;

CREATE FUNCTION "eraser_capture_protected_publication"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target_chat TEXT; row_data JSONB; v_message_id TEXT; column_name TEXT; fence_started TIMESTAMP(3); fence_key TEXT;
BEGIN
  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  target_chat := CASE WHEN TG_TABLE_NAME = 'chat_rules' THEN row_data->>'chat_id' ELSE row_data->>'source_chat_id' END;
  fence_key := TG_TABLE_NAME || ':' || (row_data->>'id');
  fence_started := CASE WHEN TG_OP = 'DELETE' THEN NULL WHEN TG_TABLE_NAME = 'chat_rules' THEN (row_data->>'publish_send_started_at')::timestamp ELSE (row_data->>'locked_at')::timestamp END;
  IF fence_started IS NULL THEN
    DELETE FROM eraser_publication_fences WHERE chat_id = target_chat AND source_key = fence_key;
  ELSE
    INSERT INTO eraser_publication_fences(chat_id, source_key, started_at) VALUES(target_chat, fence_key, fence_started)
    ON CONFLICT(chat_id, source_key) DO UPDATE SET started_at = EXCLUDED.started_at;
  END IF;
  -- FLAG: Never revoke an old rules/giveaway ID when a producer replaces or deletes its row.
  FOREACH column_name IN ARRAY ARRAY['published_message_id', 'publication_message_id', 'results_message_id'] LOOP
    v_message_id := row_data->>column_name;
    IF v_message_id IS NOT NULL AND v_message_id <> '' THEN
      INSERT INTO eraser_protected_messages(chat_id, message_id) VALUES(target_chat, v_message_id)
      ON CONFLICT DO NOTHING;
    END IF;
    IF TG_OP = 'UPDATE' THEN
      v_message_id := to_jsonb(OLD)->>column_name;
      IF v_message_id IS NOT NULL AND v_message_id <> '' THEN
        INSERT INTO eraser_protected_messages(chat_id, message_id) VALUES(target_chat, v_message_id)
        ON CONFLICT DO NOTHING;
      END IF;
    END IF;
  END LOOP;
  FOREACH column_name IN ARRAY ARRAY['published_bot_id', 'pending_cleanup_bot_id', 'publication_bot_id', 'results_bot_id'] LOOP
    v_message_id := row_data->>column_name;
    IF v_message_id IS NOT NULL AND v_message_id <> '' THEN
      INSERT INTO eraser_protected_bots(chat_id, bot_id) VALUES(target_chat, v_message_id) ON CONFLICT DO NOTHING;
    END IF;
    IF TG_OP = 'UPDATE' THEN
      v_message_id := to_jsonb(OLD)->>column_name;
      IF v_message_id IS NOT NULL AND v_message_id <> '' THEN
        INSERT INTO eraser_protected_bots(chat_id, bot_id) VALUES(target_chat, v_message_id) ON CONFLICT DO NOTHING;
      END IF;
    END IF;
  END LOOP;
  PERFORM eraser_mark_protection_dirty(target_chat);
  RETURN NULL;
END $$;

CREATE TRIGGER "eraser_chat_rules_protection" AFTER INSERT OR UPDATE OR DELETE ON "chat_rules"
  FOR EACH ROW EXECUTE FUNCTION eraser_capture_protected_publication();
CREATE TRIGGER "eraser_giveaway_protection" AFTER INSERT OR UPDATE OR DELETE ON "managed_giveaways"
  FOR EACH ROW EXECUTE FUNCTION eraser_capture_protected_publication();

CREATE FUNCTION "eraser_capture_source_hold"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE row_data JSONB := to_jsonb(NEW); target_chat TEXT := row_data->>'chat_id'; v_message_id TEXT := row_data->>'message_id';
BEGIN
  -- FLAG: Only legacy recoveries carry global-author immunity. Modern abandoned sources stay exact-message.
  IF TG_TABLE_NAME = 'webhook_legacy_recoveries' THEN
    INSERT INTO eraser_held_authors(author_id) VALUES(row_data->>'user_id') ON CONFLICT DO NOTHING;
  END IF;
  IF v_message_id IS NOT NULL AND EXISTS(SELECT 1 FROM eraser_chat_bindings WHERE chat_id = target_chat) THEN
    INSERT INTO eraser_protected_messages(chat_id, message_id, held) VALUES(target_chat, v_message_id, TRUE)
      ON CONFLICT(chat_id, message_id) DO UPDATE SET held = TRUE, delivered = FALSE;
    PERFORM eraser_mark_protection_dirty(target_chat);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER "eraser_legacy_source_hold" AFTER INSERT ON "webhook_legacy_recoveries"
  FOR EACH ROW EXECUTE FUNCTION eraser_capture_source_hold();
CREATE TRIGGER "eraser_abandoned_source_hold" AFTER INSERT ON "webhook_source_abandonments"
  FOR EACH ROW EXECUTE FUNCTION eraser_capture_source_hold();
CREATE TRIGGER "eraser_cancelled_source_hold" AFTER INSERT ON "webhook_backlog_receipts"
  FOR EACH ROW EXECUTE FUNCTION eraser_capture_source_hold();
