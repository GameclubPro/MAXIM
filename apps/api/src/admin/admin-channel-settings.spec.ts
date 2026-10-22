import { channelSettingsSchema } from '@maxim/contracts';
import { readChannelSettings, saveChannelSettings } from './admin-channel-settings';

describe('channel settings normalization', () => {
  it('preserves subscription protection when a legacy settings client omits the new fields', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const audit = jest.fn();
    const tx = {
      chat: { upsert: jest.fn().mockResolvedValue({ id: '-1', fixedModeratorBotId: null }) },
      channelSettings: {
        updateMany,
        findUnique: jest.fn().mockResolvedValue({ revision: 0 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ revision: 1 }),
      },
      auditLog: { create: audit },
    };
    await saveChannelSettings({
      prisma: { $transaction: async (run: (db: typeof tx) => unknown) => run(tx) } as never,
      chatContextCache: { invalidate: jest.fn() },
      chatId: '-1',
      actorUserId: 'admin',
      body: { revision: 0, postSuggestionsEnabled: true },
      source: 'miniapp',
      resolveBotAssignmentData: () => ({ botId: 'major', primaryBotId: 'major' }),
      refreshExecutionReadiness: jest.fn(),
    });
    const saved = updateMany.mock.calls[0][0];
    expect(saved.where).toEqual({ chatId: '-1', revision: 0 });
    expect(saved.data).not.toHaveProperty('postSuggestionsRequireSubscription');
    expect(saved.data).not.toHaveProperty('postSuggestionsDeleteOnUnsubscribe');
    expect(audit.mock.calls[0][0].data.payload).not.toHaveProperty(
      'postSuggestionsRequireSubscription',
    );
  });
  it('repairs a malformed stored button with an optimistic version guard', async () => {
    const updatedAt = new Date('2026-07-19T08:00:00.000Z');
    const storedSettings = {
      ...channelSettingsSchema.parse({
        commentsEnabled: true,
        postSuggestionsButtonEnabled: true,
        postSuggestionsButtonUrl: 'https://max.ru/chat/example/https://nested.example.test',
      }),
      updatedAt,
      revision: 0,
    };
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });

    const upsert = jest.fn().mockResolvedValue({ channelSettings: storedSettings });
    const result = await readChannelSettings({
      prisma: {
        chat: { upsert },
        channelSettings: { updateMany },
      } as never,
      logger: { warn: jest.fn() },
      chatId: 'channel-1',
      botAssignmentData: {
        botId: 'stale-bot',
        primaryBotId: 'stale-bot',
      },
    });

    expect(result.commentsEnabled).toBe(true);
    expect(result.postSuggestionsButtonEnabled).toBe(false);
    expect(result.postSuggestionsButtonUrl).toBe('');
    expect(updateMany).toHaveBeenCalledWith({
      where: { chatId: 'channel-1', revision: 0 },
      data: expect.objectContaining({
        postSuggestionsButtonEnabled: false,
        postSuggestionsButtonUrl: '',
      }),
    });
    const upsertArgs = upsert.mock.calls[0]?.[0];
    expect(upsertArgs?.create).toEqual(
      expect.objectContaining({ botId: 'stale-bot', primaryBotId: 'stale-bot' }),
    );
    expect(upsertArgs?.update).not.toHaveProperty('botId');
    expect(upsertArgs?.update).not.toHaveProperty('primaryBotId');
  });
});
