ALTER TABLE eraser_protection_state ADD COLUMN bot_history_complete_from timestamptz;
ALTER TABLE eraser_policies ADD COLUMN historical_deferred_from bigint;
ALTER TABLE eraser_policies ADD COLUMN historical_deferred_to bigint;
