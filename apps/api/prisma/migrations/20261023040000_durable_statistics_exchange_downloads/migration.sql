-- Additive bounded staging: imported read models remain unchanged until atomic activation.
ALTER TABLE statistics_exchange_grants
  ADD COLUMN last_attempt_at TIMESTAMPTZ,
  ADD COLUMN last_remote_access_attempt_at TIMESTAMPTZ,
  ADD COLUMN last_remote_access_error_at TIMESTAMPTZ,
  ADD COLUMN last_error_phase TEXT,
  ADD COLUMN last_error_entity TEXT,
  ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0);
ALTER TABLE statistics_exchange_entities
  ADD COLUMN next_stats_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN last_stats_attempt_at TIMESTAMPTZ,
  ADD COLUMN last_stats_at TIMESTAMPTZ,
  ADD COLUMN stats_error TEXT,
  ADD COLUMN stats_error_phase TEXT,
  ADD COLUMN stats_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (stats_failure_count >= 0),
  ADD COLUMN stats_phase_health JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE statistics_exchange_downloads (
  id UUID PRIMARY KEY,
  grant_id UUID NOT NULL,
  grant_revision BIGINT NOT NULL CHECK (grant_revision > 0),
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('CHAT','CHANNEL')),
  local_binding_id UUID NOT NULL,
  remote_binding_id UUID NOT NULL,
  generation_id UUID NOT NULL,
  producer_revision BIGINT NOT NULL CHECK (producer_revision >= 0),
  manifest JSONB NOT NULL,
  next_cursor TEXT CHECK (octet_length(next_cursor) <= 8192),
  page_count INTEGER NOT NULL DEFAULT 0 CHECK (page_count BETWEEN 0 AND 20),
  received_rows INTEGER NOT NULL DEFAULT 0 CHECK (received_rows BETWEEN 0 AND 3000),
  received_bytes INTEGER NOT NULL DEFAULT 0 CHECK (received_bytes BETWEEN 0 AND 2621440),
  last_page_at TIMESTAMPTZ,
  state TEXT NOT NULL DEFAULT 'DOWNLOADING' CHECK (state IN ('DOWNLOADING','READY')),
  lease_id UUID,
  lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT statistics_exchange_downloads_entity_fk FOREIGN KEY(grant_id,entity_id,kind)
    REFERENCES statistics_exchange_entities(grant_id,entity_id,kind) ON DELETE CASCADE,
  CONSTRAINT statistics_exchange_downloads_entity_key UNIQUE(grant_id,grant_revision,entity_id,kind),
  CHECK (state <> 'READY' OR (next_cursor IS NULL AND page_count > 0))
);
CREATE INDEX statistics_exchange_downloads_expiry_idx ON statistics_exchange_downloads(expires_at,id);
CREATE TABLE statistics_exchange_download_pages (
  download_id UUID NOT NULL REFERENCES statistics_exchange_downloads(id) ON DELETE CASCADE,
  page_ordinal INTEGER NOT NULL CHECK (page_ordinal BETWEEN 0 AND 19),
  request_cursor TEXT CHECK (octet_length(request_cursor) <= 8192),
  next_cursor TEXT CHECK (octet_length(next_cursor) <= 8192),
  rows_text TEXT NOT NULL CHECK (octet_length(rows_text) <= 131072),
  rows_sha256 TEXT NOT NULL CHECK (rows_sha256 ~ '^[a-f0-9]{64}$'),
  row_count INTEGER NOT NULL CHECK (row_count BETWEEN 0 AND 200),
  byte_count INTEGER NOT NULL CHECK (byte_count BETWEEN 0 AND 131072),
  PRIMARY KEY(download_id,page_ordinal)
);

-- Only a one-way fingerprint of the server credential is stored; no token or peer payload.
CREATE TABLE statistics_exchange_peer_limits (
  peer_key TEXT PRIMARY KEY CHECK (peer_key ~ '^EXCHANGE:[a-f0-9]{64}$'),
  next_request_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
