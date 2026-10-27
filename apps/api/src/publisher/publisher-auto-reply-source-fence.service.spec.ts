import {
  WebhookExecutionClaimStatus,
  WebhookStatus,
  type Prisma,
  type WebhookEvent,
  type WebhookExecutionClaim,
} from '../prisma/prisma-client';
import {
  PUBLISHER_AUTO_REPLY_SOURCE_FENCE_TESTING,
  PublisherAutoReplySourceFenceService,
  PublisherAutoReplySourceReceiptHeldError,
} from './publisher-auto-reply-source-fence.service';

const identity = {
  publisherBotId: 'publisher-bot',
  chatId: '-100',
  sourceMessageId: 'message-1',
};

type AdmissionReceipt = Pick<
  WebhookEvent,
  | 'status'
  | 'errorMessage'
  | 'legacyDispositionId'
  | 'legacyDispositionReceiptId'
  | 'sourceDispositionId'
  | 'sourceDispositionReceiptId'
>;

function harness(
  states: Array<WebhookExecutionClaimStatus | null>,
  receipt: AdmissionReceipt | null = {
    status: WebhookStatus.RECEIVED,
    errorMessage: null,
    legacyDispositionId: null,
    legacyDispositionReceiptId: null,
    sourceDispositionId: null,
    sourceDispositionReceiptId: null,
  },
) {
  const findUnique = jest.fn().mockImplementation(() => {
    const status = states.shift() ?? null;
    return Promise.resolve(status ? { status } : null);
  });
  const createMany = jest.fn().mockResolvedValue({ count: 1 });
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const queryRaw = jest.fn(
    async (
      query: Prisma.Sql,
    ): Promise<Array<AdmissionReceipt | Pick<WebhookExecutionClaim, 'status'>>> => {
      const sql = query.strings.join(' ');
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('FROM webhook_events')) return receipt ? [receipt] : [];
      return [{ status: WebhookExecutionClaimStatus.READY }];
    },
  );
  const model = { findUnique, createMany, updateMany };
  const prisma = {
    webhookExecutionClaim: model,
    $transaction: jest.fn(
      (
        callback: (tx: {
          webhookExecutionClaim: typeof model;
          $queryRaw: typeof queryRaw;
        }) => unknown,
      ) => callback({ webhookExecutionClaim: model, $queryRaw: queryRaw }),
    ),
  };
  return {
    service: new PublisherAutoReplySourceFenceService(prisma as never),
    prisma,
    findUnique,
    createMany,
    updateMany,
    queryRaw,
  };
}

describe('PublisherAutoReplySourceFenceService', () => {
  it('creates one READY admission without exposing source identities in the semantic key', async () => {
    const { service, createMany } = harness([null, WebhookExecutionClaimStatus.READY]);

    await expect(
      service.admit({ ...identity, sourceWebhookEventId: 'webhook-created-1' }),
    ).resolves.toBe('admitted');

    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          kind: PUBLISHER_AUTO_REPLY_SOURCE_FENCE_TESTING.kind,
          semanticKey:
            'publisher-auto-reply-source:9784a8ddb0bc2a9d63a2e2c5a8e317f1db4a31280d55893f559a269036660331',
          webhookEventId: 'webhook-created-1',
          status: WebhookExecutionClaimStatus.READY,
        }),
      ],
      skipDuplicates: true,
    });
    expect(JSON.stringify(createMany.mock.calls)).not.toContain('message-1');
    expect(JSON.stringify(createMany.mock.calls)).not.toContain('-100');
  });

  it('turns an admitted source into an absorbing COMPLETED cancellation', async () => {
    const { service, prisma, createMany, updateMany } = harness([
      WebhookExecutionClaimStatus.READY,
    ]);

    await service.cancel({ ...identity, sourceWebhookEventId: 'webhook-removed-1' });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ status: WebhookExecutionClaimStatus.COMPLETED })],
      }),
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: PUBLISHER_AUTO_REPLY_SOURCE_FENCE_TESTING.kind,
          status: { not: WebhookExecutionClaimStatus.COMPLETED },
        }),
        data: expect.objectContaining({
          webhookEventId: 'webhook-removed-1',
          status: WebhookExecutionClaimStatus.COMPLETED,
        }),
      }),
    );
  });

  it('accepts a duplicate cancellation without requiring another webhook id', async () => {
    const { service, prisma } = harness([WebhookExecutionClaimStatus.COMPLETED]);

    await expect(
      service.cancel({ ...identity, sourceWebhookEventId: null }),
    ).resolves.toBeUndefined();

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('never admits over an existing cancellation tombstone', async () => {
    const { service, createMany } = harness([WebhookExecutionClaimStatus.COMPLETED]);

    await expect(
      service.admit({ ...identity, sourceWebhookEventId: 'webhook-created-late-1' }),
    ).resolves.toBe('canceled');

    expect(createMany).not.toHaveBeenCalled();
  });

  it.each(['admit', 'cancel'] as const)(
    'refuses %s from a receipt closed after its first read without writing source claims',
    async (operation) => {
      const { service, createMany, updateMany } = harness([null], {
        status: WebhookStatus.NO_REPLAY_HELD,
        errorMessage: null,
        legacyDispositionId: 'disposition-1',
        legacyDispositionReceiptId: 'proof-1',
        sourceDispositionId: null,
        sourceDispositionReceiptId: null,
      });

      await expect(
        service[operation]({ ...identity, sourceWebhookEventId: 'webhook-closed-1' }),
      ).rejects.toBeInstanceOf(PublisherAutoReplySourceReceiptHeldError);

      expect(createMany).not.toHaveBeenCalled();
      expect(updateMany).not.toHaveBeenCalled();
    },
  );

  it('refuses a duplicate cancellation from a held receipt before callers can mutate delivery journals', async () => {
    const { service, createMany, updateMany } = harness([WebhookExecutionClaimStatus.COMPLETED], {
      status: WebhookStatus.NO_REPLAY_HELD,
      errorMessage: null,
      legacyDispositionId: 'disposition-1',
      legacyDispositionReceiptId: 'proof-1',
      sourceDispositionId: null,
      sourceDispositionReceiptId: null,
    });

    await expect(
      service.cancel({ ...identity, sourceWebhookEventId: 'webhook-closed-duplicate' }),
    ).rejects.toBeInstanceOf(PublisherAutoReplySourceReceiptHeldError);

    expect(createMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('locks the source claim and admits dispatch only from READY', async () => {
    const { service, queryRaw } = harness([]);
    const tx = { $queryRaw: queryRaw } as never;

    await expect(service.lockAdmitted(tx, identity)).resolves.toBe(true);
    queryRaw.mockResolvedValueOnce([{ status: WebhookExecutionClaimStatus.COMPLETED }]);
    await expect(service.lockAdmitted(tx, identity)).resolves.toBe(false);

    const query = queryRaw.mock.calls[0]?.[0] as { strings?: readonly string[] } | undefined;
    expect(query?.strings?.join(' ')).toContain('publisher_auto_reply_source_fence_lock');
    expect(query?.strings?.join(' ')).toContain('FOR UPDATE');
  });
});
