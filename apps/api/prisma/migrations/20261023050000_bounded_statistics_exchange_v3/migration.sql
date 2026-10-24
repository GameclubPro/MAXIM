-- Parallel v3 transport; strict legacy payloads and visible projections stay compatible.
CREATE TABLE statistics_exchange_membership_actors (
  actor_user_id TEXT PRIMARY KEY,
  revision BIGINT NOT NULL CHECK(revision>=0),
  sha256 TEXT NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE statistics_exchange_membership_snapshots (
  id UUID PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  request_id UUID NOT NULL,
  membership_revision BIGINT NOT NULL CHECK(membership_revision>=0),
  sha256 TEXT NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  entity_count INTEGER NOT NULL CHECK(entity_count>=0),
  page_count INTEGER NOT NULL CHECK(page_count>=0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE(actor_user_id,request_id)
);
CREATE INDEX statistics_exchange_membership_snapshots_expiry_idx ON statistics_exchange_membership_snapshots(expires_at,id);
CREATE TABLE statistics_exchange_membership_snapshot_entities (
  snapshot_id UUID NOT NULL REFERENCES statistics_exchange_membership_snapshots(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('CHAT','CHANNEL')),
  profile TEXT NOT NULL CHECK(profile IN ('moderation','publisher')),
  PRIMARY KEY(snapshot_id,ordinal),
  UNIQUE(snapshot_id,kind,entity_id)
);
CREATE TABLE statistics_exchange_membership_snapshot_pages (
  snapshot_id UUID NOT NULL REFERENCES statistics_exchange_membership_snapshots(id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL CHECK(page_index>=0),
  payload JSONB NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 0 AND 65536),
  PRIMARY KEY(snapshot_id,page_index)
);
ALTER TABLE statistics_exchange_grants
  ADD COLUMN membership_snapshot_id UUID,
  ADD COLUMN membership_revision BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN membership_sha256 TEXT,
  ADD COLUMN membership_entity_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN access_revision BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN remote_access_cursor TEXT CHECK(octet_length(remote_access_cursor)<=8192),
  ADD COLUMN remote_access_revision BIGINT,
  ADD COLUMN remote_access_sweep_id UUID,
  ADD COLUMN remote_access_sweep_started_at TIMESTAMPTZ,
  ADD COLUMN remote_protocol INTEGER,
  ADD COLUMN remote_protocol_checked_at TIMESTAMPTZ;
ALTER TABLE statistics_exchange_entities
  ADD COLUMN access_signature TEXT,
  ADD COLUMN access_binding_revision BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN remote_access_seen UUID,
  ADD COLUMN remote_binding_revision BIGINT,
  ADD COLUMN remote_access_scopes JSONB,
  ADD COLUMN remote_is_public BOOLEAN,
  ADD COLUMN remote_statistics_health JSONB;
ALTER TABLE statistics_exchange_imports ADD COLUMN v3_content JSONB;
ALTER TABLE statistics_exchange_downloads ADD COLUMN v3_head JSONB;
CREATE TABLE statistics_exchange_v3_generations (
  id UUID PRIMARY KEY,
  grant_id UUID NOT NULL REFERENCES statistics_exchange_grants(id),
  grant_revision BIGINT NOT NULL,
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('CHAT','CHANNEL')),
  binding_id UUID NOT NULL,
  native_generation_id UUID NOT NULL,
  content_hash TEXT NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
  material_hash TEXT NOT NULL CHECK(material_hash ~ '^[a-f0-9]{64}$'),
  context_hash TEXT NOT NULL CHECK(context_hash ~ '^[a-f0-9]{64}$'),
  content JSONB NOT NULL,
  scope_observations JSONB NOT NULL,
  retention_from TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX statistics_exchange_v3_generations_latest_idx ON statistics_exchange_v3_generations(grant_id,grant_revision,kind,entity_id,created_at DESC,id DESC);
CREATE INDEX statistics_exchange_v3_generations_expiry_idx ON statistics_exchange_v3_generations(retention_from,id);
CREATE TABLE statistics_exchange_v3_generation_pages (
  generation_id UUID NOT NULL REFERENCES statistics_exchange_v3_generations(id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL CHECK(page_index>=0 AND page_index<20),
  rows_text TEXT NOT NULL CHECK(octet_length(rows_text)<=131072),
  row_count INTEGER NOT NULL CHECK(row_count BETWEEN 1 AND 200),
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 0 AND 131072),
  sha256 TEXT NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY(generation_id,page_index)
);
