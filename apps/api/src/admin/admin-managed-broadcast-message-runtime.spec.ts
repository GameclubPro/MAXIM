import { AdminManagedBroadcastMessageRuntime } from './admin-managed-broadcast-message-runtime';
import type { ManagedBroadcastCommentDialogReference } from './admin-managed-broadcast-ledger';

const reference: ManagedBroadcastCommentDialogReference = {
  entityType: 'chat',
  threadId: 'thread-publik',
  includeCommentsButton: true,
  includeSuggestButton: false,
  suggestButtonText: null,
  customButtons: [],
  suggestionEntryMode: null,
  botId: 'publisher-bot',
  dialogBotId: 'publisher-bot',
};
const publishedUrlRequestOptions: NonNullable<
  Parameters<
    AdminManagedBroadcastMessageRuntime['recordDialogReference']
  >[0]['publishedUrlRequestOptions']
> = {
  botId: 'publisher-bot',
  trafficClass: 'background',
  actionHealthLane: 'background',
  sourceTag: 'managed_broadcast',
};
const params = {
  chatId: 'chat-target',
  actorUserId: 'admin-1',
  messageId: 'mid-publik',
  reference,
  source: 'deadline',
  broadcastId: 'broadcast-publik',
  occurrenceIndex: 1,
};

function createHarness() {
  const resolveMessageLink = jest.fn().mockResolvedValue('https://max.ru/channel/mid-publik');
  const auditLogCreate = jest.fn().mockResolvedValue({});
  const logger = { warn: jest.fn() };
  const runtime = new AdminManagedBroadcastMessageRuntime(
    {
      maxClient: { resolveMessageLink },
      prisma: { auditLog: { create: auditLogCreate } },
    } as never,
    logger as never,
  );
  return { runtime, resolveMessageLink, auditLogCreate, logger };
}

describe('AdminManagedBroadcastMessageRuntime dialog reference links', () => {
  it('awaits an opted-in link lookup with the exact request options before recording its URL', async () => {
    const { runtime, resolveMessageLink, auditLogCreate } = createHarness();
    resolveMessageLink.mockImplementation(async () => {
      expect(auditLogCreate).not.toHaveBeenCalled();
      return 'https://max.ru/channel/mid-publik';
    });

    await runtime.recordDialogReference({ ...params, publishedUrlRequestOptions });

    expect(resolveMessageLink).toHaveBeenCalledWith('mid-publik', publishedUrlRequestOptions);
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-target',
        actorUserId: 'admin-1',
        payload: expect.objectContaining({
          messageId: 'mid-publik',
          threadId: 'thread-publik',
          botId: 'publisher-bot',
          dialogBotId: 'publisher-bot',
          publishedUrl: 'https://max.ru/channel/mid-publik',
        }),
      }),
    });
  });

  it('preserves legacy callers without optional lookup options', async () => {
    const { runtime, resolveMessageLink, auditLogCreate } = createHarness();

    await runtime.recordDialogReference(params);

    expect(resolveMessageLink).not.toHaveBeenCalled();
    expect(auditLogCreate).toHaveBeenCalledTimes(1);
    expect(auditLogCreate.mock.calls[0]![0].data.payload).not.toHaveProperty('publishedUrl');
  });

  it('uses a supplied URL without fetching the message', async () => {
    const { runtime, resolveMessageLink, auditLogCreate } = createHarness();

    await runtime.recordDialogReference({
      ...params,
      publishedUrl: ' https://max.ru/channel/direct-url ',
      publishedUrlRequestOptions,
    });

    expect(resolveMessageLink).not.toHaveBeenCalled();
    expect(auditLogCreate.mock.calls[0]![0].data.payload.publishedUrl).toBe(
      'https://max.ru/channel/direct-url',
    );
  });

  it.each([
    { label: 'no message receipt', messageId: null, reference },
    { label: 'no dialog reference', messageId: 'mid-publik', reference: null },
    {
      label: 'disabled dialog buttons',
      messageId: 'mid-publik',
      reference: { ...reference, includeCommentsButton: false, includeSuggestButton: false },
    },
  ])('skips both optional lookup and reference creation for $label', async (state) => {
    const { runtime, resolveMessageLink, auditLogCreate } = createHarness();

    await runtime.recordDialogReference({ ...params, ...state, publishedUrlRequestOptions });

    expect(resolveMessageLink).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
  });

  it('records the reference without a URL when optional lookup fails', async () => {
    const { runtime, resolveMessageLink, auditLogCreate, logger } = createHarness();
    resolveMessageLink.mockRejectedValue(new Error('temporary link lookup failure'));

    await expect(
      runtime.recordDialogReference({ ...params, publishedUrlRequestOptions }),
    ).resolves.toBeUndefined();

    expect(auditLogCreate).toHaveBeenCalledTimes(1);
    expect(auditLogCreate.mock.calls[0]![0].data.payload).not.toHaveProperty('publishedUrl');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'temporary link lookup failure' }),
      'Managed broadcast comment dialog link lookup failed after persisted send receipt',
    );
  });

  it('keeps reference persistence failure contained after a successful lookup', async () => {
    const { runtime, auditLogCreate, logger } = createHarness();
    auditLogCreate.mockRejectedValue(new Error('temporary reference write failure'));

    await expect(
      runtime.recordDialogReference({ ...params, publishedUrlRequestOptions }),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'temporary reference write failure' }),
      'Failed to record managed broadcast comments button reference',
    );
  });
});
