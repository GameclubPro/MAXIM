import type { PrismaService } from '../prisma/prisma.service';

type ChannelSettingsTestDelegate = Pick<
  PrismaService['channelSettings'],
  'findUnique' | 'findUniqueOrThrow' | 'create' | 'findMany' | 'upsert' | 'update' | 'updateMany'
>;

export function createChannelSettingsPrismaMock() {
  return {
    findUnique: jest.fn().mockResolvedValue(null),
    findUniqueOrThrow: jest.fn().mockResolvedValue({ revision: 1 }),
    create: jest.fn().mockResolvedValue({ revision: 1 }),
    findMany: jest.fn().mockResolvedValue([]),
    upsert: jest.fn().mockResolvedValue({
      chatId: 'channel-1',
      postSuggestionsEnabled: false,
      postSuggestionsEntryMode: 'BOT',
      postSuggestionsButtonText: 'Предложить пост',
      commentsEnabled: false,
      engagementPublishedMessageId: null,
      engagementPublishedBotId: null,
      engagementPublishedThreadId: null,
      engagementPublishedAt: null,
    }),
    update: jest.fn().mockResolvedValue(undefined),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  } satisfies ChannelSettingsTestDelegate;
}
