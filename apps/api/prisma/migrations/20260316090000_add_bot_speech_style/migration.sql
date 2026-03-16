CREATE TYPE "BotSpeechStyle" AS ENUM ('ROBOT', 'FRIENDLY', 'POLICE', 'IRONIC');

ALTER TABLE "chat_settings"
ADD COLUMN "bot_speech_style" "BotSpeechStyle";
