-- Existing imported history: build outside a transaction without blocking the shared workload.
CREATE INDEX CONCURRENTLY statistics_exchange_imports_retention_idx
  ON statistics_exchange_imports(grant_id,grant_revision,retention_checked_from,entity_id,kind);
