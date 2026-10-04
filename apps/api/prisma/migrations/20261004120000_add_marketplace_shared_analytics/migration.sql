CREATE TABLE marketplace_bindings (
  id UUID PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('CHAT', 'CHANNEL')),
  profile TEXT NOT NULL CHECK (profile IN ('moderation', 'publisher')),
  bot_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (state IN ('ACTIVE', 'UNKNOWN', 'REVOKED')),
  revision INTEGER NOT NULL DEFAULT 0,
  checked_at TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}',
  statistics_consent BOOLEAN NOT NULL DEFAULT false,
  collection_owner TEXT NOT NULL DEFAULT 'SHADOW' CHECK(collection_owner IN ('SHADOW', 'MAXIM')),
  collection_metrics JSONB NOT NULL DEFAULT '[]',
  append_enabled BOOLEAN NOT NULL DEFAULT false,
  append_revision INTEGER NOT NULL DEFAULT 0,
  profile_revision INTEGER NOT NULL DEFAULT 0,
  profile_snapshot JSONB,
  public_url TEXT,
  public_verified_until TIMESTAMPTZ,
  generation_id UUID,
  statistics_checked_at TIMESTAMPTZ,
  native_history_checked_at TIMESTAMPTZ,
  native_full_checked_at TIMESTAMPTZ,
  native_audience_checked_at TIMESTAMPTZ,
  history_from TIMESTAMPTZ,
  history_to TIMESTAMPTZ,
  history_cursor TIMESTAMPTZ,
  history_complete BOOLEAN NOT NULL DEFAULT false,
  history_signature TEXT,
  discovery_from TIMESTAMPTZ,
  discovery_to TIMESTAMPTZ,
  history_anomaly BOOLEAN NOT NULL DEFAULT false,
  button_diagnostic TEXT,
  next_collect_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_access_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_id UUID,
  lease_until TIMESTAMPTZ,
  UNIQUE(actor_user_id, entity_id, profile)
);
CREATE INDEX marketplace_bindings_collect_idx ON marketplace_bindings(next_collect_at, id);
CREATE INDEX marketplace_bindings_access_idx ON marketplace_bindings(next_access_at, id);
CREATE INDEX marketplace_bindings_entity_idx ON marketplace_bindings(entity_id, state);

CREATE TABLE marketplace_statistics_generations (
  id UUID PRIMARY KEY,
  binding_id UUID NOT NULL REFERENCES marketplace_bindings(id),
  manifest JSONB NOT NULL,
  rows JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX marketplace_generations_expiry_idx ON marketplace_statistics_generations(created_at, id);

CREATE TABLE marketplace_post_samples (
  binding_id UUID NOT NULL REFERENCES marketplace_bindings(id),
  message_id TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL,
  views INTEGER,
  observed_at TIMESTAMPTZ,
  views_24 INTEGER,
  captured_24 TIMESTAMPTZ,
  views_48 INTEGER,
  captured_48 TIMESTAMPTZ,
  next_sample_at TIMESTAMPTZ,
  PRIMARY KEY(binding_id, message_id)
);
CREATE INDEX marketplace_post_samples_due_idx ON marketplace_post_samples(next_sample_at, binding_id, message_id);
CREATE INDEX marketplace_post_samples_history_idx ON marketplace_post_samples(binding_id, published_at, message_id);
CREATE INDEX marketplace_post_samples_expiry_idx ON marketplace_post_samples(published_at, binding_id, message_id);

CREATE TABLE marketplace_audience_observations (
  binding_id UUID NOT NULL REFERENCES marketplace_bindings(id),
  bucket TIMESTAMPTZ NOT NULL,
  audience INTEGER NOT NULL CHECK(audience >= 0),
  observed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(binding_id, bucket)
);

CREATE INDEX marketplace_audience_expiry_idx ON marketplace_audience_observations(bucket, binding_id);

CREATE TABLE marketplace_policy_requests (
  request_id UUID PRIMARY KEY,
  binding_id UUID NOT NULL REFERENCES marketplace_bindings(id),
  payload_hash TEXT NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
