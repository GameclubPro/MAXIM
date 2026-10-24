-- Additive independent statistics store. No native history or product authority is changed.
CREATE TABLE stats_entities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL CHECK (kind IN ('CHANNEL','CHAT')),
 max_id text NOT NULL CHECK (max_id ~ '^-[1-9][0-9]{0,19}$'), data_revision bigint NOT NULL DEFAULT 0 CHECK (data_revision>=0),
 health jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(health)='object'), created_at timestamptz(6) NOT NULL DEFAULT now(),
 UNIQUE(kind,max_id)
);
CREATE TABLE stats_authorities (
 id uuid PRIMARY KEY, entity_id uuid NOT NULL REFERENCES stats_entities(id) ON DELETE CASCADE,
 issuer text NOT NULL CHECK (issuer IN ('MAXIM','EXCHANGE')), role text NOT NULL CHECK (role IN ('SOURCE','CONSUMER')),
 producer text NOT NULL CHECK (producer IN ('MAXIM','EXCHANGE')), consumer text NOT NULL CHECK (consumer IN ('MAXIM','EXCHANGE')),
 actor_max_id text NOT NULL, bot_ref text NOT NULL, purpose text NOT NULL CHECK (purpose IN ('OWNER_ANALYTICS','PUBLISHED_AGGREGATE')),
 scopes jsonb NOT NULL CHECK (jsonb_typeof(scopes)='array' AND jsonb_array_length(scopes) BETWEEN 1 AND 32),
 revision bigint NOT NULL CHECK (revision>0), epoch bigint NOT NULL CHECK (epoch>0), producer_epoch uuid NOT NULL,
 local_access_fence text NOT NULL, state text NOT NULL CHECK(state IN ('ACTIVE','REVOKED')),
 peer_valid_until timestamptz(6) NOT NULL, checked_at timestamptz(6) NOT NULL, updated_at timestamptz(6) NOT NULL DEFAULT now(), native_ref jsonb,
 CONSTRAINT stats_authorities_scope_key UNIQUE(issuer,role,entity_id,producer,consumer,actor_max_id,bot_ref,purpose)
);
CREATE INDEX stats_authorities_actor_entity_idx ON stats_authorities(actor_max_id,entity_id,purpose,role);
CREATE INDEX stats_authorities_lease_idx ON stats_authorities(issuer,state,peer_valid_until,id);
CREATE TABLE stats_measurements (
 entity_id uuid NOT NULL REFERENCES stats_entities(id) ON DELETE CASCADE, producer text NOT NULL CHECK (producer IN ('MAXIM','EXCHANGE')),
 metric text NOT NULL CHECK(metric IN ('AUDIENCE','MEMBERSHIP','REACH','PUBLICATION_HOUR')), horizon integer NOT NULL CHECK(horizon IN (0,24,48)),
 method_id text NOT NULL CHECK(method_id IN ('AUDIENCE_SNAPSHOT','POST_PUBLICATION_DAY','TIMED_POST_PUBLICATION_DAY','RECENT_POST_SAMPLE_20','PUBLICATION_DAY_HOURS','OBSERVED_MEMBER_EVENTS','MAXFRAME_EXTERNAL_CALENDAR')),
 method_version integer NOT NULL CHECK(method_version=1), day date NOT NULL, producer_epoch uuid NOT NULL,
 seen_revision bigint NOT NULL CHECK(seen_revision>=0), seen_hash text NOT NULL, value_revision bigint NOT NULL CHECK(value_revision>=0), value_hash text NOT NULL,
 deleted boolean NOT NULL DEFAULT false, value jsonb, coverage jsonb, observed_from timestamptz(6), observed_to timestamptz(6),
 delete_fence bigint NOT NULL DEFAULT 0 CHECK(delete_fence>=0), collected_authority_id uuid,
 updated_at timestamptz(6) NOT NULL DEFAULT now(), PRIMARY KEY(entity_id,producer,metric,horizon,method_id,method_version,day),
 CHECK((metric='REACH' AND ((horizon=0 AND method_id IN ('POST_PUBLICATION_DAY','RECENT_POST_SAMPLE_20')) OR (horizon IN (24,48) AND method_id='TIMED_POST_PUBLICATION_DAY'))) OR
 (horizon=0 AND ((metric='AUDIENCE' AND method_id IN ('AUDIENCE_SNAPSHOT','MAXFRAME_EXTERNAL_CALENDAR')) OR (metric='MEMBERSHIP' AND method_id='OBSERVED_MEMBER_EVENTS') OR (metric='PUBLICATION_HOUR' AND method_id='PUBLICATION_DAY_HOURS')))),
 CHECK(deleted OR (value IS NOT NULL AND coverage IS NOT NULL))
);
CREATE INDEX stats_measurements_entity_day_idx ON stats_measurements(entity_id,day,metric,horizon);
CREATE INDEX stats_measurements_retention_idx ON stats_measurements(day,entity_id);
CREATE TABLE stats_ingest_requests (
 producer text NOT NULL CHECK(producer IN ('MAXIM','EXCHANGE')), producer_epoch uuid NOT NULL,
 record_kind text NOT NULL CHECK(record_kind IN ('REQUEST','EVENT')), operation_key text NOT NULL, body_hash text NOT NULL,
 result jsonb NOT NULL, created_at timestamptz(6) NOT NULL DEFAULT now(), PRIMARY KEY(producer,producer_epoch,record_kind,operation_key)
);
CREATE INDEX stats_ingest_requests_retention_idx ON stats_ingest_requests(created_at,producer,producer_epoch,record_kind,operation_key);
CREATE TABLE stats_changes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_id uuid NOT NULL REFERENCES stats_entities(id) ON DELETE CASCADE,
 entity_revision bigint NOT NULL, cause text NOT NULL CHECK(cause IN ('DATA','AUTHORITY','DELETE')), authority_id uuid,
 created_at timestamptz(6) NOT NULL DEFAULT now(), published_seq bigint UNIQUE, published_at timestamptz(6)
);
CREATE INDEX stats_changes_unpublished_idx ON stats_changes(created_at,id) WHERE published_seq IS NULL;
CREATE INDEX stats_changes_retention_idx ON stats_changes(created_at,id);
