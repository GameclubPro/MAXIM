ALTER TABLE "managed_broadcast_deliveries"
  ADD CONSTRAINT "managed_broadcast_deliveries_dispatch_route_publisher_owned_check" CHECK (
    (
      "dispatch_profile" = 'LEGACY_ROUTED'::"PublicationDispatchProfile"
      AND "required_bot_id" IS NULL
    )
    OR (
      "dispatch_profile" = 'PUBLIK_V1'::"PublicationDispatchProfile"
      AND "publication_occurrence_id" IS NOT NULL
      AND BTRIM(COALESCE("required_bot_id", '')) <> ''
      AND BTRIM(COALESCE("dialog_bot_id", '')) <> ''
      AND COALESCE("publication_policy_revision", -1) >= 0
      AND ("bot_id" IS NULL OR "bot_id" = "required_bot_id")
    )
  ) NOT VALID;

ALTER TABLE "managed_broadcast_deliveries"
  VALIDATE CONSTRAINT "managed_broadcast_deliveries_dispatch_route_publisher_owned_check";

ALTER TABLE "managed_broadcast_deliveries"
  DROP CONSTRAINT "managed_broadcast_deliveries_dispatch_route_check";

ALTER TABLE "managed_broadcast_deliveries"
  RENAME CONSTRAINT "managed_broadcast_deliveries_dispatch_route_publisher_owned_check"
  TO "managed_broadcast_deliveries_dispatch_route_check";

ALTER TABLE "vk_parsing_posts"
  ADD CONSTRAINT "vk_parsing_posts_dispatch_route_publisher_owned_check" CHECK (
    (
      "dispatch_profile" = 'LEGACY_ROUTED'::"PublicationDispatchProfile"
      AND "required_bot_id" IS NULL
      AND "dialog_bot_id" IS NULL
      AND "publish_dialog_context" IS NULL
      AND "publication_policy_revision" IS NULL
    )
    OR (
      "dispatch_profile" = 'PUBLIK_V1'::"PublicationDispatchProfile"
      AND BTRIM(COALESCE("required_bot_id", '')) <> ''
      AND BTRIM(COALESCE("dialog_bot_id", '')) <> ''
      AND COALESCE(
        "is_valid_publisher_dialog_context"("publish_dialog_context", "dialog_bot_id"),
        false
      )
      AND COALESCE("publication_policy_revision", -1) >= 0
    )
  ) NOT VALID;

ALTER TABLE "vk_parsing_posts"
  VALIDATE CONSTRAINT "vk_parsing_posts_dispatch_route_publisher_owned_check";

ALTER TABLE "vk_parsing_posts"
  DROP CONSTRAINT "vk_parsing_posts_dispatch_route_check";

ALTER TABLE "vk_parsing_posts"
  RENAME CONSTRAINT "vk_parsing_posts_dispatch_route_publisher_owned_check"
  TO "vk_parsing_posts_dispatch_route_check";
