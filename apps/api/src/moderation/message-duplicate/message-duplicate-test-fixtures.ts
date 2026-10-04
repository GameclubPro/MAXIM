import { chatSettingsSchema } from '@maxim/contracts';
import type { ChatSettings } from '../../prisma/prisma-client';
import { WebhookParser } from '../../webhook/webhook.parser';

// Recorded from the pre-Unicode matcher at 1333fa9 with duplicateSettings below.
export const preUnicodeNearSettingsDigests = {
  STRICT: '1a1c2877f9325e5f2563d675c4ad27c05b097bdcf22210205525f4be1ea06da5',
  CUSTOM: '0f816f04439405d78f988f0eefe7b353cb29d650365aa6c9b6fd6be5598d65d0',
} as const;

// Recorded before conservative phone evidence/internal punctuation at the v6 settings fence.
export const preSafeTextSettingsDigests = {
  STRICT: 'c06758cff6d8639bbe465fcd54b7a0b1aeb9d7115791f10025ee97b827a04c15',
  CUSTOM_NEAR: '04c88045d7a64dbea9096ead840a2ccb8d5a8d0b206ce1588b2dd9fe2a225655',
  CUSTOM_PHONE: '98a9f5799b58c3d38147b6228ab73583621b394074a5942fd6e231905d61b284',
} as const;

export function duplicateSettings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  return {
    ...chatSettingsSchema.parse({}),
    duplicateDetectionPreset: 'STANDARD',
    antiDuplicateEnabled: true,
    duplicatePolicyRevision: 0,
    duplicateHistoryRevision: 0,
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
