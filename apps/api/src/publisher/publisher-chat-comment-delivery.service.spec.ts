import { UnrecoverableError } from 'bullmq';
import { PublisherChatCommentDeliveryService } from './publisher-chat-comment-delivery.service';
import type {
  PublisherChatCommentAttachJob,
  PublisherCommentKeyboardEditJob,
} from './publisher-chat-comment.queue';

const ATTACH_LOCK_TOKEN = 'publisher-chat-comment:v1:7:3:lock-1';

type MarkerRow = {
  id: string;
  chatId: string;
  messageId: string;
  status: 'IN_PROGRESS' | 'SUCCEEDED' | 'SKIPPED';
  lockToken: string | null;
  lockedAt: Date | null;
  botId: string | null;
  deliveryMode: string | null;
  replacementMessageId: string | null;
  replyMessageId: string | null;
  replacementSendStartedAt: Date | null;
  lastError: string | null;
  lastStatusCode: number | null;
  originalDeleted: boolean;
};

type PublisherSettingsRow = {
  revision: number;
  chatCommentsEnabled: boolean;
  chatCommentsAdminsEnabled: boolean;
};

type PublicationPolicyRow = {
  revision: number;
  publikEnabled: boolean;
};

function createMarkerDelegate(
  row: MarkerRow,
  readPublisherSettings: () => PublisherSettingsRow,
  readPublicationPolicy: () => PublicationPolicyRow | null,
) {
  return {
    findUnique: jest.fn(async () => ({ ...row })),
    updateMany: jest.fn(async (args: unknown) => {
      const input = args as {
        where?: Record<string, unknown> & { status?: string | { in?: string[] } };
        data?: Partial<MarkerRow>;
      };
      const where = input.where ?? {};
      if (typeof where.id === 'string' && where.id !== row.id) return { count: 0 };
      if (typeof where.chatId === 'string' && where.chatId !== row.chatId) return { count: 0 };
      if (typeof where.messageId === 'string' && where.messageId !== row.messageId) {
        return { count: 0 };
      }
      if (typeof where.lockToken === 'string' && where.lockToken !== row.lockToken) {
        return { count: 0 };
      }
      if (typeof where.status === 'string' && where.status !== row.status) return { count: 0 };
      if (
        typeof where.status === 'object' &&
        Array.isArray(where.status.in) &&
        !where.status.in.includes(row.status)
      ) {
        return { count: 0 };
      }
      for (const field of [
        'replacementMessageId',
        'replyMessageId',
        'replacementSendStartedAt',
      ] as const) {
        if (field in where && where[field] !== row[field]) return { count: 0 };
      }
      const chatFilter = where.chat as
        | {
            publisherSettings?: { is?: Partial<PublisherSettingsRow> };
            publicationPolicy?: { is?: Partial<PublicationPolicyRow> | null };
          }
        | undefined;
      const settingsFilter = chatFilter?.publisherSettings?.is;
      const settings = readPublisherSettings();
      if (
        settingsFilter &&
        Object.entries(settingsFilter).some(
          ([key, value]) => settings[key as keyof PublisherSettingsRow] !== value,
        )
      ) {
        return { count: 0 };
      }
      const policyFilter = chatFilter?.publicationPolicy?.is;
      const policy = readPublicationPolicy();
      if (
        policyFilter === null
          ? policy !== null
          : policyFilter &&
            (!policy ||
              Object.entries(policyFilter).some(
                ([key, value]) => policy[key as keyof PublicationPolicyRow] !== value,
              ))
      ) {
        return { count: 0 };
      }
      Object.assign(row, input.data ?? {});
      return { count: 1 };
    }),
  };
}

function buildAttachJob(): PublisherChatCommentAttachJob {
  return {
    version: 1,
    kind: 'attach_chat_reply',
    markerId: `ccr1_${'a'.repeat(32)}`,
    lockToken: ATTACH_LOCK_TOKEN,
    chatId: 'chat-1',
    messageId: 'message-1',
    senderId: 'admin-1',
    requiredBotId: 'publik-bot',
    dialogBotId: 'main-bot',
    publisherSettingsRevision: 7,
    publicationPolicyRevision: 3,
    button: {
      type: 'link',
      text: 'Comments 0',
      url: 'https://max.ru/main-bot?startapp=dialog',
    },
    idempotencyKey: `ccr1_${'a'.repeat(32)}`,
    sourceTag: 'chat_auto_comment',
    retryPolicyName: 'publisher-chat-comment',
    createdAt: '2026-08-26T09:00:00.000Z',
  };
}

function buildKeyboardJob(): PublisherCommentKeyboardEditJob {
  return {
    version: 1,
    kind: 'edit_comment_keyboard',
    entityType: 'chat',
    readinessFeature: 'chat_comments',
    chatId: 'chat-1',
    messageId: 'publisher-message-1',
    threadId: 'thread-1',
    requiredBotId: 'publik-bot',
    dialogBotId: 'main-bot',
    buttons: [[{ type: 'link', text: 'Comments 6', url: 'https://example.test/dialog' }]],
    commentsButton: { rowIndex: 0, columnIndex: 0, baseText: 'Comments' },
    countSnapshot: 6,
    idempotencyKey: 'chat:chat-1:publisher-message-1:thread-1',
    sourceTag: 'comment_button_count',
    retryPolicyName: 'publisher-chat-comment',
    createdAt: '2026-08-26T09:00:00.000Z',
  };
}

function createHarness() {
  const row: MarkerRow = {
    id: `ccr1_${'a'.repeat(32)}`,
    chatId: 'chat-1',
    messageId: 'message-1',
    status: 'IN_PROGRESS',
    lockToken: ATTACH_LOCK_TOKEN,
    lockedAt: new Date('2026-08-26T09:00:00.000Z'),
    botId: 'main-bot',
    deliveryMode: null,
    replacementMessageId: null,
    replyMessageId: null,
    replacementSendStartedAt: null,
    lastError: null,
    lastStatusCode: null,
    originalDeleted: false,
  };
  const publisherSettings: PublisherSettingsRow = {
    revision: 7,
    chatCommentsEnabled: true,
    chatCommentsAdminsEnabled: true,
  };
  let publicationPolicy: PublicationPolicyRow | null = {
    revision: 3,
    publikEnabled: true,
  };
  const marker = createMarkerDelegate(
    row,
    () => publisherSettings,
    () => publicationPolicy,
  );
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([{ count: 9n }]),
    chatAutoCommentAttachMarker: marker,
    chat: {
      findUnique: jest.fn(async () => ({
        publisherSettings: { ...publisherSettings },
        publicationPolicy: publicationPolicy ? { ...publicationPolicy } : null,
      })),
    },
    managedEntityAccessEdge: {
      findFirst: jest.fn().mockResolvedValue({ state: 'GRANTED', userRole: 'ADMIN' }),
    },
    publisherEntitySettings: {
      findUnique: jest.fn(async () => ({ ...publisherSettings })),
    },
    managedEntityPublicationPolicy: {
      findUnique: jest.fn(async () => (publicationPolicy ? { ...publicationPolicy } : null)),
    },
    auditLog: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(undefined),
    },
  };
  const maxClient = {
    sendMessageImmediateWithResolvedLink: jest.fn().mockImplementation(async (...args) => {
      await args[2]?.beforeSend?.();
      return { messageId: 'publisher-reply-1', url: null };
    }),
    editMessageInlineKeyboard: jest.fn().mockImplementation(async (...args) => {
      await args[3]?.beforeEditMutation?.();
    }),
  };
  const readiness = {
    assertEntityReady: jest.fn().mockResolvedValue({
      chatId: 'chat-1',
      entityType: 'chat',
      requiredBotId: 'publik-bot',
      policyRevision: 3,
    }),
  };
  const boundary = { assertDispatchEnabled: jest.fn() };
  const health = {
    assertDispatchAllowed: jest.fn().mockResolvedValue(undefined),
    recordSendFailure: jest.fn().mockResolvedValue('retryable'),
    recordSendSuccess: jest.fn().mockResolvedValue(undefined),
  };
  const dialogLinks = { buildChatDialogButton: jest.fn() };
  const bindingRefresh = { refresh: jest.fn().mockResolvedValue(undefined) };
  const service = new PublisherChatCommentDeliveryService(
    prisma as never,
    maxClient as never,
    readiness as never,
    boundary as never,
    { getBotId: () => 'publik-bot' } as never,
    dialogLinks as never,
    bindingRefresh as never,
    health as never,
  );
  return {
    row,
    publisherSettings,
    get publicationPolicy() {
      return publicationPolicy;
    },
    set publicationPolicy(value: PublicationPolicyRow | null) {
      publicationPolicy = value;
    },
    marker,
    prisma,
    maxClient,
    readiness,
    boundary,
    health,
    dialogLinks,
    bindingRefresh,
    service,
  };
}

const firstAttempt = { final: false, attemptsMade: 1, maxAttempts: 12 };

describe('PublisherChatCommentDeliveryService', () => {
  it('sends once through the immutable publisher and completes marker plus audit', async () => {
    const harness = createHarness();

    await harness.service.process(buildAttachJob(), firstAttempt);

    expect(harness.readiness.assertEntityReady).toHaveBeenCalledTimes(3);
    expect(harness.readiness.assertEntityReady).toHaveBeenCalledWith('chat-1', 'chat_comments');
    expect(harness.boundary.assertDispatchEnabled).toHaveBeenCalledTimes(3);
    expect(harness.maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'chat-1',
      '\u200B',
      expect.objectContaining({
        messageLink: { type: 'reply', mid: 'message-1' },
        beforeSend: expect.any(Function),
      }),
      expect.objectContaining({ botId: 'publik-bot', sourceTag: 'comment_notification' }),
    );
    expect(harness.prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: 'admin-1',
        payload: expect.objectContaining({
          botId: 'publik-bot',
          publisherBotId: 'publik-bot',
          dialogBotId: 'main-bot',
          replyMessageId: 'publisher-reply-1',
        }),
      }),
    });
    expect(harness.row).toMatchObject({
      status: 'SUCCEEDED',
      botId: 'publik-bot',
      replyMessageId: 'publisher-reply-1',
      replacementSendStartedAt: null,
    });
    expect(harness.health.recordSendSuccess).toHaveBeenCalledWith('chat-1');
  });

  it('quarantines an ambiguous attempted send and never sends it again', async () => {
    const harness = createHarness();
    harness.maxClient.sendMessageImmediateWithResolvedLink.mockImplementation(async (...args) => {
      await args[2]?.beforeSend?.();
      throw Object.assign(new Error('send timed out'), { code: 'ETIMEDOUT' });
    });
    const job = buildAttachJob();

    await harness.service.process(job, firstAttempt);
    await harness.service.process(job, firstAttempt);

    expect(harness.maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    expect(harness.row).toMatchObject({
      status: 'SKIPPED',
      botId: 'publik-bot',
      replacementSendStartedAt: expect.any(Date),
      lastError: expect.stringContaining('[max.send_ambiguous]'),
    });
  });

  it('does not send when admin comments are toggled off after enqueue', async () => {
    const harness = createHarness();
    harness.maxClient.sendMessageImmediateWithResolvedLink.mockImplementation(async (...args) => {
      harness.publisherSettings.chatCommentsAdminsEnabled = false;
      harness.publisherSettings.revision += 1;
      await args[2]?.beforeSend?.();
      throw new Error('beforeSend must reject changed settings');
    });

    await harness.service.process(buildAttachJob(), firstAttempt);

    expect(harness.row).toMatchObject({
      status: 'SKIPPED',
      replacementSendStartedAt: null,
      lastError: 'Publisher chat-comment settings changed before dispatch',
    });
    expect(harness.prisma.auditLog.create).not.toHaveBeenCalled();
    expect(harness.health.recordSendFailure).not.toHaveBeenCalled();
  });

  it('does not resurrect a queued message after settings are disabled and re-enabled', async () => {
    const harness = createHarness();
    harness.publisherSettings.revision = 9;

    await harness.service.process(buildAttachJob(), firstAttempt);

    expect(harness.maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(harness.row).toMatchObject({
      status: 'SKIPPED',
      replacementSendStartedAt: null,
      lastError: 'Publisher chat-comment settings changed before dispatch',
    });
  });

  it('does not resurrect a queued message after the main Publik toggle is disabled and re-enabled', async () => {
    const harness = createHarness();
    harness.publicationPolicy = { revision: 5, publikEnabled: true };

    await harness.service.process(buildAttachJob(), firstAttempt);

    expect(harness.maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(harness.row).toMatchObject({
      status: 'SKIPPED',
      replacementSendStartedAt: null,
      lastError: 'Publisher chat-comment settings changed before dispatch',
    });
  });

  it('fails closed for a legacy pre-send job without both settings revisions', async () => {
    const harness = createHarness();
    const legacyJob = buildAttachJob() as unknown as {
      publisherSettingsRevision?: number;
      publicationPolicyRevision?: number;
    };
    delete legacyJob.publisherSettingsRevision;
    delete legacyJob.publicationPolicyRevision;

    await harness.service.process(legacyJob as PublisherChatCommentAttachJob, firstAttempt);

    expect(harness.maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(harness.row).toMatchObject({
      status: 'SKIPPED',
      replacementSendStartedAt: null,
      lastError: 'Publisher chat-comment settings changed before dispatch',
    });
  });

  it('quarantines a crash fence even while current readiness is disabled', async () => {
    const harness = createHarness();
    harness.row.botId = 'publik-bot';
    harness.row.deliveryMode = 'reply_message';
    harness.row.replacementSendStartedAt = new Date('2026-08-26T09:00:01.000Z');
    harness.readiness.assertEntityReady.mockRejectedValue(new Error('publisher is disabled'));

    await harness.service.process(buildAttachJob(), firstAttempt);

    expect(harness.readiness.assertEntityReady).not.toHaveBeenCalled();
    expect(harness.maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(harness.row).toMatchObject({
      status: 'SKIPPED',
      replacementSendStartedAt: new Date('2026-08-26T09:00:01.000Z'),
      lastError: expect.stringContaining('[max.send_ambiguous]'),
    });
  });

  it('recovers a confirmed reply audit from the durable job without another send', async () => {
    const harness = createHarness();
    harness.row.botId = 'publik-bot';
    harness.row.deliveryMode = 'reply_message';
    harness.row.replyMessageId = 'publisher-reply-recovery';

    await harness.service.process(buildAttachJob(), firstAttempt);

    expect(harness.maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(harness.readiness.assertEntityReady).not.toHaveBeenCalled();
    expect(harness.prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.objectContaining({
          botId: 'publik-bot',
          dialogBotId: 'main-bot',
          replyMessageId: 'publisher-reply-recovery',
        }),
      }),
    });
    expect(harness.row).toMatchObject({ status: 'SUCCEEDED', lockToken: null });
  });

  it('keeps a definitive 429 retryable without changing the exact bot', async () => {
    const harness = createHarness();
    harness.maxClient.sendMessageImmediateWithResolvedLink.mockImplementation(async (...args) => {
      await args[2]?.beforeSend?.();
      throw Object.assign(new Error('rate limited'), { response: { status: 429 } });
    });

    await expect(harness.service.process(buildAttachJob(), firstAttempt)).rejects.toThrow(
      'rate limited',
    );

    expect(harness.health.recordSendFailure).toHaveBeenCalledTimes(1);
    expect(harness.row).toMatchObject({
      status: 'IN_PROGRESS',
      botId: 'publik-bot',
      replacementSendStartedAt: null,
      lastStatusCode: 429,
    });
    expect(harness.maxClient.sendMessageImmediateWithResolvedLink.mock.calls[0]?.[3]).toMatchObject(
      {
        botId: 'publik-bot',
      },
    );
  });

  it.each([401, 403, 404])(
    'reports definitive HTTP %s to publisher health without fallback',
    async (status) => {
      const harness = createHarness();
      const failure = Object.assign(new Error(`publisher HTTP ${status}`), {
        response: { status },
      });
      harness.maxClient.sendMessageImmediateWithResolvedLink.mockImplementation(async (...args) => {
        await args[2]?.beforeSend?.();
        throw failure;
      });

      await expect(harness.service.process(buildAttachJob(), firstAttempt)).rejects.toThrow(
        `publisher HTTP ${status}`,
      );

      expect(harness.health.recordSendFailure).toHaveBeenCalledWith('chat-1', failure);
      expect(harness.maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
      expect(harness.row).toMatchObject({
        status: 'IN_PROGRESS',
        botId: 'publik-bot',
        replacementSendStartedAt: null,
        lastStatusCode: status,
      });
    },
  );

  it('treats a readiness rejection inside beforeSend as proven predispatch', async () => {
    const harness = createHarness();
    const setupRequired = Object.assign(new Error('publisher policy changed'), {
      getStatus: () => 409,
    });
    harness.readiness.assertEntityReady
      .mockResolvedValueOnce({
        chatId: 'chat-1',
        entityType: 'chat',
        requiredBotId: 'publik-bot',
        policyRevision: 3,
      })
      .mockResolvedValueOnce({
        chatId: 'chat-1',
        entityType: 'chat',
        requiredBotId: 'publik-bot',
        policyRevision: 3,
      })
      .mockRejectedValueOnce(setupRequired);

    await expect(harness.service.process(buildAttachJob(), firstAttempt)).rejects.toThrow(
      'publisher policy changed',
    );

    expect(harness.row).toMatchObject({
      status: 'IN_PROGRESS',
      replacementSendStartedAt: null,
      lastStatusCode: 409,
    });
    expect(harness.prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('never clears a send fence won by a competing recovery worker', async () => {
    const harness = createHarness();
    const updateMarker = harness.marker.updateMany.getMockImplementation();
    const competingFence = new Date('2026-08-26T09:00:02.000Z');
    harness.marker.updateMany.mockImplementation(async (args: unknown) => {
      const data = (args as { data?: Partial<MarkerRow> }).data;
      if (data?.replacementSendStartedAt instanceof Date) {
        harness.row.replacementSendStartedAt = competingFence;
        harness.publisherSettings.chatCommentsAdminsEnabled = false;
        harness.publisherSettings.revision += 1;
        return { count: 0 };
      }
      return updateMarker?.(args) ?? { count: 0 };
    });
    const job = buildAttachJob();

    await expect(harness.service.process(job, firstAttempt)).resolves.toBeUndefined();
    expect(harness.row.replacementSendStartedAt).toEqual(competingFence);

    await harness.service.process(job, firstAttempt);
    expect(harness.maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    expect(harness.row).toMatchObject({
      status: 'SKIPPED',
      replacementSendStartedAt: competingFence,
      lastError: expect.stringContaining('[max.send_ambiguous]'),
    });
  });

  it('keeps an unstarted marker pending after the final automatic attempt', async () => {
    const harness = createHarness();
    harness.readiness.assertEntityReady.mockRejectedValue(
      Object.assign(new Error('publisher is disabled'), { getStatus: () => 409 }),
    );

    await expect(
      harness.service.process(buildAttachJob(), {
        final: true,
        attemptsMade: 12,
        maxAttempts: 12,
      }),
    ).rejects.toThrow('publisher is disabled');

    expect(harness.row).toMatchObject({
      status: 'IN_PROGRESS',
      lockToken: ATTACH_LOCK_TOKEN,
      replacementSendStartedAt: null,
      lastStatusCode: 409,
    });
    expect(harness.maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('refreshes a publisher-origin keyboard with the latest persisted count', async () => {
    const harness = createHarness();

    await harness.service.process(buildKeyboardJob(), {
      final: false,
      attemptsMade: 1,
      maxAttempts: 8,
    });

    expect(harness.readiness.assertEntityReady).toHaveBeenCalledTimes(3);
    expect(harness.prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const countSql = harness.prisma.$queryRaw.mock.calls[0]?.[0]?.sql ?? '';
    expect(countSql).toContain("audit.action = 'PUBLISHER_CHAT_DIALOG_COMMENT'");
    expect(countSql).toContain("audit.payload->>'threadId' =");
    expect(harness.maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'chat-1',
      'publisher-message-1',
      null,
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: 'Comments · 9' })]],
      }),
      expect.objectContaining({ botId: 'publik-bot' }),
    );
  });

  it('rejects a keyboard edit whose immutable origin differs from readiness', async () => {
    const harness = createHarness();
    const job = { ...buildKeyboardJob(), requiredBotId: 'another-bot' };

    await expect(
      harness.service.process(job, { final: false, attemptsMade: 1, maxAttempts: 8 }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(harness.maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
  });

  it('rejects an attach route that does not resolve to the configured publisher', async () => {
    const harness = createHarness();
    harness.readiness.assertEntityReady.mockResolvedValue({
      chatId: 'chat-1',
      entityType: 'chat',
      requiredBotId: 'another-bot',
      policyRevision: 3,
    });

    await expect(harness.service.process(buildAttachJob(), firstAttempt)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    expect(harness.maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(harness.row).toMatchObject({ lockToken: null, replacementSendStartedAt: null });
  });
});
