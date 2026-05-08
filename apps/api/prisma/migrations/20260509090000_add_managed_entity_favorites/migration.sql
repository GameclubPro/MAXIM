-- CreateEnum
CREATE TYPE "ManagedEntityFavoriteType" AS ENUM (
    'IMPORTANT',
    'WATCH',
    'BROADCAST',
    'TEST',
    'PARTNER',
    'SERVICE'
);

-- CreateTable
CREATE TABLE "managed_entity_favorites" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "entity_type" "ChatEntityType" NOT NULL DEFAULT 'CHAT',
    "favorite_type" "ManagedEntityFavoriteType" NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "managed_entity_favorites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "managed_entity_favorites_user_entity_chat_type_key"
ON "managed_entity_favorites"("user_id", "entity_type", "chat_id", "favorite_type");

-- CreateIndex
CREATE INDEX "managed_entity_favorites_user_type_position_idx"
ON "managed_entity_favorites"("user_id", "entity_type", "favorite_type", "position");

-- CreateIndex
CREATE INDEX "managed_entity_favorites_chat_id_idx"
ON "managed_entity_favorites"("chat_id");

-- AddForeignKey
ALTER TABLE "managed_entity_favorites"
ADD CONSTRAINT "managed_entity_favorites_chat_id_fkey"
FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
