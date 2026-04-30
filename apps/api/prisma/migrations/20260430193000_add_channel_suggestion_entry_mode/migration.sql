CREATE TYPE "ChannelSuggestionEntryMode" AS ENUM ('BOT', 'MINIAPP');

ALTER TABLE "channel_settings"
ADD COLUMN "post_suggestions_entry_mode" "ChannelSuggestionEntryMode" NOT NULL DEFAULT 'BOT';
