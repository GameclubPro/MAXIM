CREATE TYPE "ChannelAutoPostButtonsMode" AS ENUM ('OFF', 'COMMENTS', 'SUGGEST', 'BOTH');

ALTER TABLE "channel_settings"
ADD COLUMN "auto_post_buttons_mode" "ChannelAutoPostButtonsMode" NOT NULL DEFAULT 'OFF';
