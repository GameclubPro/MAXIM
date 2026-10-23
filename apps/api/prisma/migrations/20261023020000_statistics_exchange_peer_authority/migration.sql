-- Peer authority is independent of locally refreshed MAX permissions.
-- Existing NULL proof deliberately grants no exchange access until a fresh handshake.
ALTER TABLE statistics_exchange_grants ADD COLUMN remote_access_version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE statistics_exchange_grants ADD COLUMN next_remote_access_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE statistics_exchange_grants ADD COLUMN last_remote_access_at TIMESTAMPTZ;
ALTER TABLE statistics_exchange_grants ADD COLUMN remote_access_error TEXT;
ALTER TABLE statistics_exchange_entities ADD COLUMN remote_valid_until TIMESTAMPTZ;
ALTER TABLE statistics_exchange_entities ADD COLUMN remote_binding_id UUID;
ALTER TABLE statistics_exchange_imports ADD COLUMN remote_valid_until TIMESTAMPTZ;
