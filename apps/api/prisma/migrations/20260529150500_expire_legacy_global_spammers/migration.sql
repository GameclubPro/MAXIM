UPDATE "global_spammers"
SET "expires_at" = CURRENT_TIMESTAMP
WHERE "expires_at" IS NULL;
