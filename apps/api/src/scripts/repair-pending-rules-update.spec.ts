import {
  readPendingRulesUpdateOptions,
  repairPendingRulesUpdate,
} from './repair-pending-rules-update';

const args = [
  '--chat-id=-123',
  '--message-id=mid.current',
  '--pending-message-id=mid.old',
  '--bot-id=bot_5',
];
const revision = '2026-09-12T07:23:38.707Z';

function fixture() {
  let row = {
    id: 'rules-1',
    chatId: '-123',
    text: 'Saved rules',
    textFormat: 'plain',
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    autoTextEnabled: false,
    buttons: [],
    buttonEnabled: false,
    buttonUrl: '',
    buttonText: 'Open',
    adminContactButtonEnabled: false,
    adminContactButtonUrl: '',
    publishedMessageId: 'mid.current',
    publishedBotId: 'bot_5',
    publishedUrl: 'https://max.ru/example/message/1',
    publishedAt: new Date(revision),
    publishOperationId: null as string | null,
    publishOperationBotId: null as string | null,
    publishSendStartedAt: null as Date | null,
    pendingCleanupMessageId: 'mid.old',
    pendingCleanupBotId: 'bot_9',
    pendingCleanupIntentId: 'old-intent',
    pendingCleanupKind: 'republish_previous',
    createdAt: new Date(revision),
    updatedAt: new Date(revision),
  };
  const prisma = {
    chatRules: {
      findUnique: jest.fn(async () => ({ ...row })),
      upsert: jest.fn(async () => ({ ...row })),
      updateMany: jest.fn(async ({ data }) => {
        row = { ...row, ...data };
        return { count: 1 };
      }),
    },
    auditLog: { create: jest.fn() },
  };
  const maxClient = {
    uploadImage: jest.fn(),
    resolveMessageLink: jest.fn(),
    replaceOwnMessage: jest.fn(async (_chatId, _messageId, _text, _options, _request, guard) => {
      await guard();
    }),
    sendMessageImmediateWithResolvedLink: jest.fn(),
    deleteMessage: jest.fn(),
  };
  const chatContextCache = { invalidate: jest.fn() };
  return {
    row: () => row,
    prisma,
    maxClient,
    chatContextCache,
    dependencies: {
      prisma: prisma as never,
      maxClient: maxClient as never,
      chatContextCache: chatContextCache as never,
    },
  };
}

describe('pending rules update repair', () => {
  it('requires reviewed exact IDs and revision for apply', () => {
    expect(readPendingRulesUpdateOptions(args).apply).toBe(false);
    expect(() => readPendingRulesUpdateOptions([...args, '--apply'])).toThrow();
    expect(() => readPendingRulesUpdateOptions([...args, '--unknown'])).toThrow();
    expect(() =>
      readPendingRulesUpdateOptions([...args, '--expected-updated-at=invalid']),
    ).toThrow();
    expect(() =>
      readPendingRulesUpdateOptions(args.map((x) => x.replace('mid.old', 'mid.current'))),
    ).toThrow();
    expect(
      readPendingRulesUpdateOptions([...args, '--apply', `--expected-updated-at=${revision}`])
        .apply,
    ).toBe(true);
  });

  it('previews without remote calls, publication writes, or content output', async () => {
    const { dependencies, prisma, maxClient } = fixture();
    const result = await repairPendingRulesUpdate(
      dependencies,
      readPendingRulesUpdateOptions(args),
    );
    expect(result).toMatchObject({ applied: false, updatedAt: revision, textLength: 11 });
    expect(result).not.toHaveProperty('text');
    expect(prisma.chatRules.upsert).not.toHaveBeenCalled();
    expect(prisma.chatRules.updateMany).not.toHaveBeenCalled();
    expect(maxClient.replaceOwnMessage).not.toHaveBeenCalled();
  });

  it('executes the same rules publication path without sending, deleting, or forgetting cleanup', async () => {
    const { dependencies, prisma, maxClient, row } = fixture();
    const options = readPendingRulesUpdateOptions([
      ...args,
      '--apply',
      `--expected-updated-at=${revision}`,
    ]);
    await expect(repairPendingRulesUpdate(dependencies, options)).resolves.toMatchObject({
      applied: true,
      messageId: 'mid.current',
    });
    expect(maxClient.replaceOwnMessage).toHaveBeenCalledWith(
      '-123',
      'mid.current',
      'Saved rules',
      undefined,
      expect.objectContaining({ botId: 'bot_5' }),
      expect.any(Function),
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(row()).toMatchObject({
      pendingCleanupMessageId: 'mid.old',
      pendingCleanupIntentId: 'old-intent',
      publishOperationId: null,
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorUserId: 'operator:rules-publication-update' }),
    });
  });

  it('refuses a stale review even when the message IDs still match', async () => {
    const { dependencies, maxClient } = fixture();
    const options = readPendingRulesUpdateOptions([
      ...args,
      '--apply',
      '--expected-updated-at=2026-09-12T07:20:00.000Z',
    ]);
    await expect(repairPendingRulesUpdate(dependencies, options)).rejects.toThrow(
      'no longer match',
    );
    expect(maxClient.replaceOwnMessage).not.toHaveBeenCalled();
  });

  it('rejects a draft change between the operator check and the publication read', async () => {
    const { dependencies, prisma, row, maxClient } = fixture();
    prisma.chatRules.upsert.mockResolvedValueOnce({
      ...row(),
      updatedAt: new Date('2026-09-12T07:25:00Z'),
    });
    const options = readPendingRulesUpdateOptions([
      ...args,
      '--apply',
      `--expected-updated-at=${revision}`,
    ]);
    await expect(repairPendingRulesUpdate(dependencies, options)).rejects.toThrow('после проверки');
    expect(prisma.chatRules.updateMany).not.toHaveBeenCalled();
    expect(maxClient.replaceOwnMessage).not.toHaveBeenCalled();
  });
});
