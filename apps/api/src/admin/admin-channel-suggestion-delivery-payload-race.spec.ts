import { AdminService } from './admin.service';
import {
  createChatContextCacheMock,
  createConfigMock,
  createPrismaMock,
  extractSqlText,
} from './admin-service-test-support';

const stalePendingPayload = {
  type: 'suggest',
  actorUserId: 'user-1',
  text: 'Публикуемый текст',
  reviewStatus: 'pending',
  delivered: false,
  deliveredToUserId: null,
  deliveredToUserIds: [],
  deliveries: [],
};

const deliveredResult = {
  delivered: true,
  deliveredToUserId: 'admin-1',
  deliveredToUserIds: ['admin-1'],
  deliveries: [
    {
      adminUserId: 'admin-1',
      privateChatId: 'private-1',
      messageId: 'review-mid-1',
      botId: 'bot-1',
    },
  ],
  deliveryAttemptedAt: '2026-08-21T10:00:00.000Z',
  deliveryFailures: [],
};

function createHarness() {
  const prisma = createPrismaMock();
  const service = new AdminService(
    prisma as never,
    {} as never,
    createChatContextCacheMock() as never,
    createConfigMock() as never,
  );
  const syncReviewed = jest
    .spyOn(service as any, 'syncChannelSuggestionAdminReviewMessages')
    .mockResolvedValue(undefined);
  return { prisma, service, syncReviewed };
}

function readJsonPatch(mock: jest.Mock): Record<string, unknown> {
  const values = (mock.mock.calls.at(-1)?.[0] as { values?: unknown[] } | undefined)?.values ?? [];
  for (const value of values) {
    if (typeof value !== 'string' || !value.startsWith('{')) {
      continue;
    }
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(parsed, 'deliveryAttemptedAt')) {
      return parsed;
    }
  }
  throw new Error('delivery JSON patch was not found');
}

describe('channel suggestion delivery payload races', () => {
  it.each([
    {
      name: 'a publish claim before context persistence',
      currentPayload: {
        ...stalePendingPayload,
        reviewStatus: 'publishing',
        reviewAction: 'publish',
        reviewClaimToken: 'claim-1',
      },
      terminal: false,
    },
    {
      name: 'the context-to-HTTP window',
      currentPayload: {
        ...stalePendingPayload,
        reviewStatus: 'publishing',
        reviewAction: 'publish',
        reviewClaimToken: 'claim-1',
        reviewPublicationContext: {
          protocol: 'max_action_ledger_v1',
          messageDigest: 'a'.repeat(64),
          contextDigest: 'b'.repeat(64),
        },
      },
      terminal: false,
    },
    {
      name: 'a finalized publication',
      currentPayload: {
        ...stalePendingPayload,
        reviewStatus: 'published',
        publishedMessageId: 'published-mid-1',
        publishedUrl: 'https://max.ru/channel-1/published-mid-1',
        reviewPublicationContext: {
          protocol: 'max_action_ledger_v1',
          messageDigest: 'a'.repeat(64),
          contextDigest: 'b'.repeat(64),
        },
      },
      terminal: true,
    },
    {
      name: 'a finalized cancellation',
      currentPayload: {
        ...stalePendingPayload,
        reviewStatus: 'cancelled',
        reviewedByUserId: 'admin-2',
      },
      terminal: true,
    },
  ])('patches delivery fields without overwriting $name', async ({ currentPayload, terminal }) => {
    const { prisma, service, syncReviewed } = createHarness();
    const returnedPayload = { ...currentPayload, ...deliveredResult };
    prisma.$queryRaw.mockImplementation(async (query: unknown) =>
      extractSqlText(query).includes('UPDATE audit_logs')
        ? [
            {
              id: 'suggestion-1',
              chatId: 'channel-1',
              actorUserId: 'user-1',
              payload: returnedPayload,
              createdAt: new Date('2026-08-21T09:00:00.000Z'),
            },
          ]
        : [],
    );

    const result = await (service as any).applyChannelSuggestionDeliveryResult(
      {
        id: 'suggestion-1',
        chatId: 'channel-1',
        actorUserId: 'user-1',
        payload: stalePendingPayload,
        createdAt: new Date('2026-08-21T09:00:00.000Z'),
      },
      deliveredResult,
    );

    const sql =
      prisma.$queryRaw.mock.calls
        .map((call) => extractSqlText(call[0]))
        .find((text) => text.includes('audit.payload::jsonb')) ?? '';
    const patch = readJsonPatch(prisma.$queryRaw);
    expect(sql).toContain('audit.payload::jsonb');
    expect(sql).toContain('RETURNING');
    expect(patch).not.toHaveProperty('reviewStatus');
    expect(patch).not.toHaveProperty('reviewClaimToken');
    expect(patch).not.toHaveProperty('reviewPublicationContext');
    expect(result.payload).toEqual(returnedPayload);
    expect(prisma.auditLog.update).not.toHaveBeenCalled();
    if (terminal) {
      expect(syncReviewed).toHaveBeenCalledWith('suggestion-1', 'channel-1', returnedPayload);
    } else {
      expect(syncReviewed).not.toHaveBeenCalled();
    }
  });

  it('guards a no-ledger failure patch by current pending status and ledger absence', async () => {
    const { prisma, service } = createHarness();
    prisma.auditLog.findUnique.mockResolvedValue({
      id: 'suggestion-failure-1',
      chatId: 'channel-1',
      actorUserId: 'user-1',
      action: 'CHANNEL_DIALOG_SUGGESTION',
      payload: stalePendingPayload,
      createdAt: new Date('2026-08-21T09:00:00.000Z'),
    });

    await service.recordChannelSuggestionDeliveryJobFailure(
      'suggestion-failure-1',
      new Error('temporary connection failure'),
      { final: true, attemptsMade: 8, maxAttempts: 8 },
    );

    const sql = extractSqlText(prisma.$executeRaw.mock.calls[0]?.[0]);
    expect(sql).toContain("audit.payload->>'reviewStatus'");
    expect(sql).toContain("= 'pending'");
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('channel_suggestion_admin_deliveries');
    expect(prisma.auditLog.update).not.toHaveBeenCalled();
  });

  it('does not overwrite a terminal review when the no-ledger failure CAS loses', async () => {
    const { prisma, service } = createHarness();
    prisma.auditLog.findUnique.mockResolvedValue({
      id: 'suggestion-failure-race-1',
      chatId: 'channel-1',
      actorUserId: 'user-1',
      action: 'CHANNEL_DIALOG_SUGGESTION',
      payload: stalePendingPayload,
      createdAt: new Date('2026-08-21T09:00:00.000Z'),
    });
    prisma.$executeRaw.mockResolvedValueOnce(0);
    prisma.channelSuggestionAdminDelivery.findMany.mockResolvedValue([]);

    await service.recordChannelSuggestionDeliveryJobFailure(
      'suggestion-failure-race-1',
      new Error('temporary connection failure'),
      { final: true, attemptsMade: 8, maxAttempts: 8 },
    );

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.auditLog.update).not.toHaveBeenCalled();
  });

  it('syncs a late SENT ledger card when job failure observes a terminal review', async () => {
    const { prisma, service, syncReviewed } = createHarness();
    const publishedPayload = {
      ...stalePendingPayload,
      reviewStatus: 'published',
      publishedMessageId: 'published-mid-1',
      publishedUrl: 'https://max.ru/channel-1/published-mid-1',
    };
    prisma.auditLog.findUnique.mockResolvedValue({
      id: 'suggestion-late-sent-1',
      chatId: 'channel-1',
      actorUserId: 'user-1',
      action: 'CHANNEL_DIALOG_SUGGESTION',
      payload: publishedPayload,
      createdAt: new Date('2026-08-21T09:00:00.000Z'),
    });
    prisma.channelSuggestionAdminDelivery.findMany.mockResolvedValue([
      {
        id: 'delivery-1',
        auditLogId: 'suggestion-late-sent-1',
        adminUserId: 'admin-1',
        botKey: 'bot-1',
        botId: 'bot-1',
        privateChatId: 'private-1',
        status: 'SENT',
        remoteMessageId: 'review-mid-1',
        terminal: false,
      },
    ]);
    prisma.$queryRaw.mockResolvedValueOnce([
      {
        id: 'suggestion-late-sent-1',
        chatId: 'channel-1',
        actorUserId: 'user-1',
        payload: { ...publishedPayload, ...deliveredResult },
        createdAt: new Date('2026-08-21T09:00:00.000Z'),
      },
    ]);

    await service.recordChannelSuggestionDeliveryJobFailure(
      'suggestion-late-sent-1',
      new Error('worker completed after timeout'),
      { final: true, attemptsMade: 8, maxAttempts: 8 },
    );

    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(syncReviewed).toHaveBeenCalledWith(
      'suggestion-late-sent-1',
      'channel-1',
      expect.objectContaining({ reviewStatus: 'published', delivered: true }),
    );
  });

  it('preserves the existing attempt cursor during observer-only ledger synchronization', async () => {
    const { prisma, service } = createHarness();
    await prisma.channelSuggestionAdminDelivery.createMany({
      data: [
        {
          auditLogId: 'suggestion-observer-sync-1',
          adminUserId: 'admin-1',
          botKey: '__default__',
          status: 'FAILED',
          terminal: true,
          lastStatusCode: 404,
          lastErrorCode: 'suggestion.delivery.dialog_unavailable',
        },
      ],
      skipDuplicates: true,
    });
    const apply = jest
      .spyOn(service as any, 'applyChannelSuggestionDeliveryResult')
      .mockResolvedValue(null);

    await (service as any).syncChannelSuggestionLegacyDeliveryPayload({
      id: 'suggestion-observer-sync-1',
      actorUserId: 'user-1',
      payload: {
        ...stalePendingPayload,
        deliveryAttemptedAt: '2026-08-21T10:00:00.000Z',
      },
      createdAt: new Date('2026-08-21T09:00:00.000Z'),
    });

    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'suggestion-observer-sync-1' }),
      expect.objectContaining({ deliveryAttemptedAt: '2026-08-21T10:00:00.000Z' }),
    );
  });
});
