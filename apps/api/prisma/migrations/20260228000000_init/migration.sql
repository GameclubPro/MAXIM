-- CreateEnum
CREATE TYPE "ProfanityLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "LinkPolicy" AS ENUM ('ALLOWLIST_ONLY', 'BLOCKLIST_ONLY', 'ALERT_ONLY');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('MESSAGE', 'MEMBER_ACTION', 'SYSTEM');

-- CreateEnum
CREATE TYPE "SanctionAction" AS ENUM ('NONE', 'WARN', 'DELETE_MESSAGE', 'KICK', 'BAN');

-- CreateEnum
CREATE TYPE "Operator" AS ENUM ('BOT', 'ADMIN');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'DUPLICATE', 'FAILED');

-- CreateTable
CREATE TABLE "chats" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_settings" (
    "id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "profanity_level" "ProfanityLevel" NOT NULL DEFAULT 'MEDIUM',
    "caps_threshold" INTEGER NOT NULL DEFAULT 70,
    "flood_window_sec" INTEGER NOT NULL DEFAULT 10,
    "flood_max_messages" INTEGER NOT NULL DEFAULT 5,
    "duplicate_window_sec" INTEGER NOT NULL DEFAULT 60,
    "duplicate_max_count" INTEGER NOT NULL DEFAULT 3,
    "link_policy" "LinkPolicy" NOT NULL DEFAULT 'ALLOWLIST_ONLY',
    "warn_threshold" INTEGER NOT NULL DEFAULT 3,
    "repeat_ban_window_days" INTEGER NOT NULL DEFAULT 7,
    "log_retention_days" INTEGER NOT NULL DEFAULT 90,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_admin_allowlist" (
    "chat_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_admin_allowlist_pkey" PRIMARY KEY ("chat_id","user_id")
);

-- CreateTable
CREATE TABLE "domain_allowlist" (
    "chat_id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_allowlist_pkey" PRIMARY KEY ("chat_id","domain")
);

-- CreateTable
CREATE TABLE "badword_dictionary" (
    "id" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "word" TEXT NOT NULL,
    "severity" INTEGER NOT NULL DEFAULT 2,
    "is_exception" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "badword_dictionary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "violations" (
    "id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "rule_code" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "violations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation_events" (
    "id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "message_id" TEXT,
    "event_type" "EventType" NOT NULL,
    "rule_code" TEXT NOT NULL,
    "action" "SanctionAction" NOT NULL,
    "masked_excerpt" TEXT,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "operator" "Operator" NOT NULL DEFAULT 'BOT',
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderation_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "dedup_key" TEXT NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "source_ip" TEXT,
    "raw_payload" JSONB NOT NULL,
    "normalized_payload" JSONB NOT NULL,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chat_settings_chat_id_key" ON "chat_settings"("chat_id");

-- CreateIndex
CREATE UNIQUE INDEX "badword_dictionary_language_word_key" ON "badword_dictionary"("language", "word");

-- CreateIndex
CREATE INDEX "violations_chat_id_user_id_created_at_idx" ON "violations"("chat_id", "user_id", "created_at");

-- CreateIndex
CREATE INDEX "moderation_events_chat_id_created_at_idx" ON "moderation_events"("chat_id", "created_at");

-- CreateIndex
CREATE INDEX "moderation_events_chat_id_user_id_created_at_idx" ON "moderation_events"("chat_id", "user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_dedup_key_key" ON "webhook_events"("dedup_key");

-- CreateIndex
CREATE INDEX "webhook_events_status_created_at_idx" ON "webhook_events"("status", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_chat_id_created_at_idx" ON "audit_logs"("chat_id", "created_at");

-- AddForeignKey
ALTER TABLE "chat_settings" ADD CONSTRAINT "chat_settings_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_admin_allowlist" ADD CONSTRAINT "chat_admin_allowlist_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_allowlist" ADD CONSTRAINT "domain_allowlist_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "violations" ADD CONSTRAINT "violations_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation_events" ADD CONSTRAINT "moderation_events_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
