ALTER TABLE "publisher_auto_reply_content_revisions"
  ADD COLUMN "buttons" JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "publisher_auto_reply_content_revisions"
  ADD CONSTRAINT "publisher_auto_reply_content_revisions_buttons_check"
  CHECK (
    jsonb_typeof("buttons") = 'array'
    AND jsonb_array_length("buttons") <= 8
  );
