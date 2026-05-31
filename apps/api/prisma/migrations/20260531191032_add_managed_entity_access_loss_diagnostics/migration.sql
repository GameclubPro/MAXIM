ALTER TABLE "managed_entity_access_edges"
  ADD COLUMN "last_max_error_code" TEXT,
  ADD COLUMN "last_max_error_message" TEXT,
  ADD COLUMN "last_max_status_code" INTEGER;
