-- Separate consent mirror and observations. Imported aggregates never enter native statistics.
ALTER TABLE marketplace_bindings ADD COLUMN statistics_v2_consent_only BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE marketplace_bindings ADD COLUMN collection_error TEXT;
CREATE TABLE statistics_exchange_grants (
  id UUID PRIMARY KEY,
  actor_user_id TEXT NOT NULL UNIQUE,
  revision BIGINT NOT NULL CHECK(revision > 0),
  state TEXT NOT NULL CHECK(state IN ('ACTIVE','REVOKED')),
  input_hash TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_pull_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_id UUID,
  lease_until TIMESTAMPTZ,
  last_pull_at TIMESTAMPTZ,
  last_error TEXT,
  pull_cursor TEXT,
  producer_revision BIGINT NOT NULL DEFAULT 0,
  prune_after_created_at TIMESTAMPTZ,
  prune_after_id UUID
);
CREATE INDEX statistics_exchange_grants_pull_idx ON statistics_exchange_grants(state,next_pull_at,id);
CREATE TABLE statistics_exchange_entities (
  grant_id UUID NOT NULL REFERENCES statistics_exchange_grants(id),
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('CHAT','CHANNEL')),
  profile TEXT NOT NULL CHECK(profile IN ('moderation','publisher')),
  binding_id UUID REFERENCES marketplace_bindings(id),
  error TEXT,
  next_check_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(grant_id,entity_id,kind)
);
CREATE INDEX statistics_exchange_entities_binding_idx ON statistics_exchange_entities(binding_id,grant_id);
CREATE INDEX statistics_exchange_entities_recovery_idx ON statistics_exchange_entities(grant_id,next_check_at,entity_id,kind) WHERE binding_id IS NULL;
CREATE TABLE statistics_exchange_generations (
  id UUID PRIMARY KEY,
  grant_id UUID NOT NULL REFERENCES statistics_exchange_grants(id),
  grant_revision BIGINT NOT NULL,
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('CHAT','CHANNEL')),
  origin TEXT NOT NULL CHECK(origin IN ('MAXIM','EXCHANGE')),
  producer_revision BIGINT NOT NULL,
  manifest JSONB NOT NULL,
  rows JSONB NOT NULL,
  retention_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX statistics_exchange_generations_latest_idx ON statistics_exchange_generations(grant_id,grant_revision,entity_id,kind,origin,producer_revision DESC,created_at DESC,id DESC);
CREATE INDEX statistics_exchange_generations_grant_expiry_idx ON statistics_exchange_generations(grant_id,created_at,id);
CREATE INDEX statistics_exchange_generations_expiry_idx ON statistics_exchange_generations(created_at,id);
CREATE INDEX statistics_exchange_generations_window_idx ON statistics_exchange_generations(retention_from,id);

-- Mutable read model is separate from the immutable uploaded generation/checksum.
CREATE TABLE statistics_exchange_imports (
  grant_id UUID NOT NULL REFERENCES statistics_exchange_grants(id),
  grant_revision BIGINT NOT NULL,
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('CHAT','CHANNEL')),
  producer_revision BIGINT NOT NULL,
  manifest JSONB NOT NULL,
  rows JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(grant_id,grant_revision,entity_id,kind)
);
