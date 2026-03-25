CREATE TABLE "admin_profile_preferences" (
    "user_id" TEXT NOT NULL,
    "profile_url" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_profile_preferences_pkey" PRIMARY KEY ("user_id")
);
