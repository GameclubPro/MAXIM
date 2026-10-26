CREATE TABLE eraser_connection_requests (
  chat_id text PRIMARY KEY REFERENCES eraser_policies(chat_id),
  operation_id uuid NOT NULL,
  actor_user_id text NOT NULL CHECK (actor_user_id ~ '^[0-9]+$'),
  policy_revision integer NOT NULL CHECK (policy_revision >= 0),
  status text NOT NULL CHECK (status IN ('pending','expired','cancelled','activated')),
  expires_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX eraser_connection_requests_due_idx
  ON eraser_connection_requests(next_attempt_at,chat_id) WHERE status='pending';
CREATE INDEX eraser_connection_requests_expiry_idx
  ON eraser_connection_requests(expires_at,chat_id) WHERE status='pending';
