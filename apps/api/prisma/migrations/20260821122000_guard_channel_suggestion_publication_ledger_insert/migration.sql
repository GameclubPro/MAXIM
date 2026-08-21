CREATE OR REPLACE FUNCTION "guard_channel_suggestion_publication_ledger_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  suggestion_id TEXT;
BEGIN
  IF NEW.action_type = 'SEND_MESSAGE'
    AND NEW.source_tag = 'suggestion_delivery'
    AND NEW.job_id LIKE 'channel-suggestion:publish:v1:%'
  THEN
    suggestion_id := substring(
      NEW.job_id FROM char_length('channel-suggestion:publish:v1:') + 1
    );

    IF suggestion_id IS NULL OR btrim(suggestion_id) = '' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'channel suggestion publication ledger job id has no suggestion id';
    END IF;

    -- FLAG: Lock a completed conflict so stale release cannot turn DO NOTHING into an orphan insert.
    PERFORM 1
    FROM public.max_action_ledger existing
    WHERE existing.job_id = NEW.job_id
      AND existing.action_type = NEW.action_type
      AND existing.chat_id = NEW.chat_id
      AND existing.source_tag = NEW.source_tag
      AND existing.status = 'SUCCEEDED'
      AND existing.ambiguous = false
      AND existing.terminal = true
      AND nullif(btrim(existing.remote_message_id), '') IS NOT NULL
    FOR KEY SHARE OF existing;

    IF FOUND THEN
      RETURN NEW;
    END IF;

    PERFORM 1
    FROM public.audit_logs audit
    WHERE audit.id = suggestion_id
      AND audit.chat_id = NEW.chat_id
      AND audit.action = 'CHANNEL_DIALOG_SUGGESTION'
      AND audit.payload->>'type' = 'suggest'
      AND audit.payload->>'reviewStatus' = 'publishing'
      AND audit.payload->>'reviewAction' = 'publish'
      AND audit.payload->>'reviewPublicationProtocol' = 'max_action_ledger_v1'
      AND audit.payload->>'reviewPublicationLedgerJobId' = NEW.job_id
      AND nullif(btrim(audit.payload->>'reviewClaimToken'), '') IS NOT NULL
      AND nullif(btrim(audit.payload->>'reviewClaimedAt'), '') IS NOT NULL
      AND pg_input_is_valid(
        audit.payload->>'reviewClaimedAt',
        'timestamp with time zone'
      )
      AND nullif(btrim(audit.payload->>'reviewClaimedByUserId'), '') IS NOT NULL
      AND (
        coalesce(jsonb_typeof(NEW.metadata->'ledgerContext'), 'null') = 'null'
        OR (
          jsonb_typeof(NEW.metadata->'ledgerContext') = 'object'
          AND NEW.metadata->'ledgerContext'->>'suggestionId' = suggestion_id
          AND NEW.metadata->'ledgerContext'->>'publicationProtocol' = 'max_action_ledger_v1'
          AND NEW.metadata->'ledgerContext'->>'claimToken'
            = audit.payload->>'reviewClaimToken'
          AND NEW.metadata->'ledgerContext'->>'actorUserId' = audit.actor_user_id
        )
      )
    FOR KEY SHARE OF audit;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'channel suggestion publication ledger insert requires an exact active claim';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "max_action_ledger_channel_suggestion_publication_insert_guard"
BEFORE INSERT ON "max_action_ledger"
FOR EACH ROW
EXECUTE FUNCTION "guard_channel_suggestion_publication_ledger_insert"();
