-- Version 1 is the legacy renderer that added titles, results, and vote counters.
ALTER TABLE "managed_polls"
  ADD COLUMN "render_format_version" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "managed_polls_render_format_version_check"
    CHECK ("render_format_version" >= 1);
