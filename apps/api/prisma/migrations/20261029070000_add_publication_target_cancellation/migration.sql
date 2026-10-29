SET lock_timeout = '2s';
SET statement_timeout = '15s';

ALTER TABLE "publication_targets" ADD COLUMN "canceled_at" TIMESTAMP(3);
