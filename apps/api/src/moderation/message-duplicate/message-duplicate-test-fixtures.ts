import { chatSettingsSchema } from '@maxim/contracts';
import type { ChatSettings } from '../../prisma/prisma-client';
import { WebhookParser } from '../../webhook/webhook.parser';

export function duplicateSettings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  return {
    ...chatSettingsSchema.parse({}),
    duplicateDetectionPreset: 'STANDARD',
    antiDuplicateEnabled: true,
    duplicateCompareMode: 'MESSAGE',
    duplicatePhotoEnabled: false,
    duplicateBotMessageEnabled: false,
    duplicateWarnEnabled: false,
    duplicateMuteEnabled: false,
    duplicateBanEnabled: false,
    duplicateWarnMaxCount: 1,
    ...overrides,
  } as ChatSettings;
}

export function duplicateUpdate(
  messageId = 'm2',
  timestamp = Date.now() - 1000,
  text = 'a',
  attachments: unknown[] = [],
) {
  return new WebhookParser().parse({
    update_type: 'message_created',
    timestamp,
    message: {
      sender: { user_id: 123, name: 'Test' },
      recipient: { chat_id: -123, chat_type: 'chat' },
      timestamp,
      body: { mid: messageId, text, attachments },
    },
  });
}
