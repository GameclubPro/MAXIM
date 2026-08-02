CREATE UNIQUE INDEX CONCURRENTLY "channel_suggestion_image_assets_audit_position_key"
ON "channel_suggestion_image_assets"("audit_log_id", "position");
