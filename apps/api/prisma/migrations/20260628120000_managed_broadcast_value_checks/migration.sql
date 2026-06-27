ALTER TABLE "managed_broadcasts"
  ADD CONSTRAINT "managed_broadcasts_text_format_check"
  CHECK ("text_format" IN ('plain', 'markdown')) NOT VALID;

ALTER TABLE "managed_broadcasts"
  ADD CONSTRAINT "managed_broadcasts_media_type_check"
  CHECK ("media_type" IS NULL OR "media_type" IN ('image', 'video')) NOT VALID;

ALTER TABLE "managed_broadcasts"
  ADD CONSTRAINT "managed_broadcasts_schedule_mode_check"
  CHECK ("schedule_mode" IN ('legacy', 'calendar')) NOT VALID;

ALTER TABLE "managed_broadcasts"
  VALIDATE CONSTRAINT "managed_broadcasts_text_format_check";

ALTER TABLE "managed_broadcasts"
  VALIDATE CONSTRAINT "managed_broadcasts_media_type_check";

ALTER TABLE "managed_broadcasts"
  VALIDATE CONSTRAINT "managed_broadcasts_schedule_mode_check";
