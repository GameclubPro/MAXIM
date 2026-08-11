ALTER TABLE "chat_settings"
  ADD COLUMN "link_policy_revision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "link_policy_effective_at" TIMESTAMPTZ(3);

-- Existing strict policies start at deployment time so recovery never moderates pre-rollout history.
UPDATE "chat_settings"
SET
  "link_policy_revision" = 1,
  "link_policy_effective_at" = CURRENT_TIMESTAMP
WHERE "link_policy" IN (
  CAST('ALLOWLIST_ONLY' AS "LinkPolicy"),
  CAST('BLOCKLIST_ONLY' AS "LinkPolicy")
);

-- FLAG: This trigger is the source of truth for recovery baselines across every settings writer.
CREATE FUNCTION "set_link_policy_recovery_baseline"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."link_policy" IN (
      CAST('ALLOWLIST_ONLY' AS "LinkPolicy"),
      CAST('BLOCKLIST_ONLY' AS "LinkPolicy")
    ) THEN
      NEW."link_policy_revision" := GREATEST(NEW."link_policy_revision", 1);
      NEW."link_policy_effective_at" := COALESCE(
        NEW."link_policy_effective_at",
        CURRENT_TIMESTAMP
      );
    ELSE
      NEW."link_policy_effective_at" := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."link_policy" IS DISTINCT FROM OLD."link_policy" THEN
    NEW."link_policy_revision" := OLD."link_policy_revision" + 1;
    NEW."link_policy_effective_at" := CASE
      WHEN NEW."link_policy" IN (
        CAST('ALLOWLIST_ONLY' AS "LinkPolicy"),
        CAST('BLOCKLIST_ONLY' AS "LinkPolicy")
      ) THEN CURRENT_TIMESTAMP
      ELSE NULL
    END;
  ELSIF NEW."link_policy_revision" > OLD."link_policy_revision" THEN
    NEW."link_policy_revision" := OLD."link_policy_revision" + 1;
    NEW."link_policy_effective_at" := CASE
      WHEN NEW."link_policy" IN (
        CAST('ALLOWLIST_ONLY' AS "LinkPolicy"),
        CAST('BLOCKLIST_ONLY' AS "LinkPolicy")
      ) THEN COALESCE(NEW."link_policy_effective_at", CURRENT_TIMESTAMP)
      ELSE NULL
    END;
  ELSE
    NEW."link_policy_revision" := OLD."link_policy_revision";
    NEW."link_policy_effective_at" := OLD."link_policy_effective_at";
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "chat_settings_link_policy_recovery_baseline"
BEFORE INSERT OR UPDATE OF "link_policy", "link_policy_revision", "link_policy_effective_at"
ON "chat_settings"
FOR EACH ROW
EXECUTE FUNCTION "set_link_policy_recovery_baseline"();

-- Allowlist changes alter ALLOWLIST_ONLY semantics, so they establish a new non-retroactive baseline.
CREATE FUNCTION "bump_link_policy_recovery_baseline_for_allowlist"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  affected_chat_id TEXT;
  previous_chat_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    affected_chat_id := OLD."chat_id";
  ELSE
    affected_chat_id := NEW."chat_id";
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."chat_id" IS DISTINCT FROM OLD."chat_id" THEN
    previous_chat_id := OLD."chat_id";
  END IF;

  UPDATE "chat_settings"
  SET
    "link_policy_revision" = "link_policy_revision" + 1,
    "link_policy_effective_at" = CURRENT_TIMESTAMP
  WHERE "link_policy" = CAST('ALLOWLIST_ONLY' AS "LinkPolicy")
    AND ("chat_id" = affected_chat_id OR "chat_id" = previous_chat_id);
  RETURN NULL;
END;
$$;

CREATE TRIGGER "domain_allowlist_link_policy_recovery_baseline"
AFTER INSERT OR UPDATE OR DELETE
ON "domain_allowlist"
FOR EACH ROW
EXECUTE FUNCTION "bump_link_policy_recovery_baseline_for_allowlist"();

CREATE TABLE "moderation_link_history_scan_states" (
  "chat_id" TEXT NOT NULL,
  "policy_revision" INTEGER NOT NULL,
  "policy_effective_at" TIMESTAMPTZ(3) NOT NULL,
  "discovery_cursor_at" TIMESTAMPTZ(3) NOT NULL,
  "repair_cursor_at" TIMESTAMPTZ(3) NOT NULL,
  "next_phase" TEXT NOT NULL DEFAULT 'DISCOVERY',
  "continuation_phase" TEXT,
  "window_lower_at" TIMESTAMPTZ(3),
  "window_upper_at" TIMESTAMPTZ(3),
  "continuation_from_at" TIMESTAMPTZ(3),
  "last_page_signature" TEXT,
  "delete_mode_prepared" BOOLEAN NOT NULL DEFAULT FALSE,
  "next_scan_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_successful_scan_at" TIMESTAMPTZ(3),
  "last_error_code" TEXT,
  "last_error_at" TIMESTAMPTZ(3),
  "lease_token" TEXT,
  "lease_expires_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "moderation_link_history_scan_states_pkey" PRIMARY KEY ("chat_id"),
  CONSTRAINT "moderation_link_history_scan_states_chat_id_fkey"
    FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "moderation_link_history_scan_states_policy_revision_check"
    CHECK ("policy_revision" >= 1),
  CONSTRAINT "moderation_link_history_scan_states_next_phase_check"
    CHECK ("next_phase" IN ('DISCOVERY', 'REPAIR')),
  CONSTRAINT "moderation_link_history_scan_states_continuation_phase_check"
    CHECK ("continuation_phase" IS NULL OR "continuation_phase" IN ('DISCOVERY', 'REPAIR'))
);

CREATE INDEX CONCURRENTLY "moderation_link_history_scan_states_due_lease_chat_idx"
ON "moderation_link_history_scan_states"("next_scan_at", "lease_expires_at", "chat_id");
