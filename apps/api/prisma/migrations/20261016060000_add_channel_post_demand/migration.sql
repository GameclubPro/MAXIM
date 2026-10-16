-- Scheduling hints only. Existing markers and final guards retain all effect authority.
CREATE TABLE "channel_post_demand_channels" (
    "chat_id" TEXT NOT NULL,
    "due_at" TIMESTAMP(3),
    CONSTRAINT "channel_post_demand_channels_pkey" PRIMARY KEY ("chat_id"),
    CONSTRAINT "channel_post_demand_channels_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "channel_post_demand_channels_due_idx" ON "channel_post_demand_channels"("due_at", "chat_id");

CREATE TABLE "channel_post_demands" (
    "chat_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "source_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "channel_post_demands_pkey" PRIMARY KEY ("chat_id", "message_id"),
    CONSTRAINT "channel_post_demands_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "channel_post_demand_channels"("chat_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "channel_post_demands_due_idx" ON "channel_post_demands"("chat_id", "due_at", "message_id");
CREATE INDEX "channel_post_demands_expiry_idx" ON "channel_post_demands"("expires_at", "chat_id", "message_id");
