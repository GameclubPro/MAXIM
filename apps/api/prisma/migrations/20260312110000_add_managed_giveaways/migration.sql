-- CreateEnum
CREATE TYPE "ManagedGiveawayStatus" AS ENUM (
    'DRAFT',
    'SCHEDULED',
    'ACTIVE',
    'DRAWING',
    'COMPLETED',
    'CANCELED'
);

-- CreateEnum
CREATE TYPE "GiveawayEligibilityState" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ManagedGiveawayWinnerStatus" AS ENUM (
    'SELECTED',
    'CLAIMED',
    'DELIVERED',
    'EXPIRED',
    'REROLLED'
);

-- CreateTable
CREATE TABLE "managed_giveaways" (
    "id" TEXT NOT NULL,
    "source_chat_id" TEXT NOT NULL,
    "entity_type" "ChatEntityType" NOT NULL DEFAULT 'CHAT',
    "actor_user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "image_enabled" BOOLEAN NOT NULL DEFAULT false,
    "image_base64" TEXT NOT NULL DEFAULT '',
    "image_mime_type" TEXT NOT NULL DEFAULT '',
    "image_file_name" TEXT NOT NULL DEFAULT '',
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3) NOT NULL,
    "claim_hours" INTEGER NOT NULL DEFAULT 24,
    "status" "ManagedGiveawayStatus" NOT NULL DEFAULT 'DRAFT',
    "publication_message_id" TEXT,
    "publication_url" TEXT,
    "published_at" TIMESTAMP(3),
    "results_message_id" TEXT,
    "results_url" TEXT,
    "draw_seed" TEXT,
    "drawn_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "canceled_at" TIMESTAMP(3),
    "locked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "managed_giveaways_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "managed_giveaway_prizes" (
    "id" TEXT NOT NULL,
    "giveaway_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "managed_giveaway_prizes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "managed_giveaway_entries" (
    "id" TEXT NOT NULL,
    "giveaway_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "display_name" TEXT,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eligibility_state" "GiveawayEligibilityState" NOT NULL DEFAULT 'PENDING',
    "eligibility_reason" TEXT,
    "checked_at" TIMESTAMP(3),
    "draw_rank" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "managed_giveaway_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "managed_giveaway_winners" (
    "id" TEXT NOT NULL,
    "giveaway_id" TEXT NOT NULL,
    "prize_id" TEXT NOT NULL,
    "entry_id" TEXT NOT NULL,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "status" "ManagedGiveawayWinnerStatus" NOT NULL DEFAULT 'SELECTED',
    "selected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claim_deadline_at" TIMESTAMP(3),
    "claimed_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "expired_at" TIMESTAMP(3),
    "rerolled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "managed_giveaway_winners_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "managed_giveaways_source_chat_id_status_created_at_idx"
ON "managed_giveaways"("source_chat_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "managed_giveaways_status_starts_at_idx"
ON "managed_giveaways"("status", "starts_at");

-- CreateIndex
CREATE INDEX "managed_giveaways_status_ends_at_idx"
ON "managed_giveaways"("status", "ends_at");

-- CreateIndex
CREATE INDEX "managed_giveaways_status_locked_at_idx"
ON "managed_giveaways"("status", "locked_at");

-- CreateIndex
CREATE UNIQUE INDEX "managed_giveaway_prizes_giveaway_id_position_key"
ON "managed_giveaway_prizes"("giveaway_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "managed_giveaway_entries_giveaway_id_user_id_key"
ON "managed_giveaway_entries"("giveaway_id", "user_id");

-- CreateIndex
CREATE INDEX "managed_giveaway_entries_giveaway_id_eligibility_state_idx"
ON "managed_giveaway_entries"("giveaway_id", "eligibility_state");

-- CreateIndex
CREATE INDEX "managed_giveaway_entries_giveaway_id_draw_rank_idx"
ON "managed_giveaway_entries"("giveaway_id", "draw_rank");

-- CreateIndex
CREATE INDEX "managed_giveaway_winners_giveaway_id_status_idx"
ON "managed_giveaway_winners"("giveaway_id", "status");

-- CreateIndex
CREATE INDEX "managed_giveaway_winners_giveaway_id_prize_id_idx"
ON "managed_giveaway_winners"("giveaway_id", "prize_id");

-- CreateIndex
CREATE INDEX "managed_giveaway_winners_entry_id_idx"
ON "managed_giveaway_winners"("entry_id");

-- AddForeignKey
ALTER TABLE "managed_giveaways"
ADD CONSTRAINT "managed_giveaways_source_chat_id_fkey"
FOREIGN KEY ("source_chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_giveaway_prizes"
ADD CONSTRAINT "managed_giveaway_prizes_giveaway_id_fkey"
FOREIGN KEY ("giveaway_id") REFERENCES "managed_giveaways"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_giveaway_entries"
ADD CONSTRAINT "managed_giveaway_entries_giveaway_id_fkey"
FOREIGN KEY ("giveaway_id") REFERENCES "managed_giveaways"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_giveaway_winners"
ADD CONSTRAINT "managed_giveaway_winners_giveaway_id_fkey"
FOREIGN KEY ("giveaway_id") REFERENCES "managed_giveaways"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_giveaway_winners"
ADD CONSTRAINT "managed_giveaway_winners_prize_id_fkey"
FOREIGN KEY ("prize_id") REFERENCES "managed_giveaway_prizes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_giveaway_winners"
ADD CONSTRAINT "managed_giveaway_winners_entry_id_fkey"
FOREIGN KEY ("entry_id") REFERENCES "managed_giveaway_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
