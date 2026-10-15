import { chatSettingsSchema } from '@maxim/contracts/settings';
import type { Prisma } from '../prisma/prisma-client';
import {
  CHAT_SETTINGS_BOT_CAPABILITY_SELECT,
  currentChatSettingsBotCapabilityRequirements,
} from '../admin/chat-settings-bot-capability';
import { readStopWordsPolicy } from '../moderation/stop-words/stop-words.policy';
import type { MaxExecutionPurpose } from './max-execution-route-proof';

export async function readFixedModeratorSettingsPurposes(
  db: Pick<Prisma.TransactionClient, 'chatSettings' | 'channelSettings'>,
  chatId: string,
  entityType: 'CHAT' | 'CHANNEL',
): Promise<MaxExecutionPurpose[]> {
  if (entityType === 'CHANNEL') {
    const settings = await db.channelSettings.findUnique({
      where: { chatId },
      select: {
        commentsEnabled: true,
        postSuggestionsEnabled: true,
        postSignatureEnabled: true,
        quickButtonsEnabled: true,
      },
    });
    return settings && Object.values(settings).some(Boolean)
      ? ['send_message', 'edit_message']
      : [];
  }
  const stored = await db.chatSettings.findUnique({
    where: { chatId },
    select: {
      ...CHAT_SETTINGS_BOT_CAPABILITY_SELECT,
      stopWordsPolicy: true,
    },
  });
  const settings = chatSettingsSchema.parse({
    ...stored,
    stopWordsPolicy: stored ? (readStopWordsPolicy(stored) ?? undefined) : undefined,
  });
  return currentChatSettingsBotCapabilityRequirements(settings).map((requirement) =>
    requirement.permission === 'add_remove_members' ? 'moderate_member' : 'send_message',
  );
}
