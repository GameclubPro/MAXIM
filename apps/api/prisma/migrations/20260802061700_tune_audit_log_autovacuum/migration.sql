-- Audit payload media lives in TOAST, so tuple-count defaults react too slowly to large rewrites.
-- These reloptions only schedule ordinary autovacuum work, and the migration does not vacuum the table.
ALTER TABLE "audit_logs" SET (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_threshold = 100,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_analyze_threshold = 500,
  toast.autovacuum_vacuum_scale_factor = 0.01,
  toast.autovacuum_vacuum_threshold = 1000
);
