-- FLAG: The validated partial index still enforces one current identity for every scope.
-- Removing the old all-history constraint permits retained, terminal predecessors.
ALTER TABLE stats_authorities DROP CONSTRAINT stats_authorities_scope_key;
