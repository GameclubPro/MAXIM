BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- FLAG: Audit import adds exact protections; finishing it never certifies pre-ownership history.
ALTER TABLE eraser_protection_outbox
  ADD COLUMN giveaway_audit_at TIMESTAMP(3),
  ADD COLUMN giveaway_audit_id TEXT,
  ADD COLUMN giveaway_audit_complete BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN giveaway_audit_count BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN evidence_revision INTEGER NOT NULL DEFAULT -1,
  ADD COLUMN evidence_stage INTEGER NOT NULL DEFAULT 0 CHECK (evidence_stage BETWEEN 0 AND 2),
  ADD COLUMN evidence_cursor TEXT,
  ADD COLUMN evidence_digest TEXT,
  ADD COLUMN evidence_count BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN delivered_evidence JSONB;

-- FLAG: Progress belongs to the permanently transferred chat, not the execution flag.
CREATE TABLE eraser_legacy_retirement (
  chat_id TEXT PRIMARY KEY,
  cursor_message_id TEXT,
  next_attempt_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP(3),
  retired_count BIGINT NOT NULL DEFAULT 0,
  reconciliation_count BIGINT NOT NULL DEFAULT 0,
  retained_count BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
COMMIT;
