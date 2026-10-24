-- Daily per-projection progress is separate from immutable measurement/provenance payloads.
ALTER TABLE statistics_exchange_imports
  ADD COLUMN retention_checked_from TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01 00:00:00+00';
ALTER TABLE statistics_exchange_grants
  ADD COLUMN next_import_prune_at TIMESTAMPTZ NOT NULL DEFAULT now();
