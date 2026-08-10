CREATE TABLE "managed_entity_favorite_preferences" (
    "user_id" TEXT NOT NULL,
    "label_overrides" JSONB NOT NULL DEFAULT '{}',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "managed_entity_favorite_preferences_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "managed_entity_favorite_preferences_user_id_check"
        CHECK (BTRIM("user_id") <> ''),
    CONSTRAINT "managed_entity_favorite_preferences_labels_object_check"
        CHECK (JSONB_TYPEOF("label_overrides") = 'object'),
    CONSTRAINT "managed_entity_favorite_preferences_revision_check"
        CHECK ("revision" > 0)
);
