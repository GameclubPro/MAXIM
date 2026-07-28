import {
  ManagedBroadcastStatus,
  ManagedBroadcastDeliveryStatus,
  PublicationDeliveryVerificationSource,
} from '../prisma/prisma-client';
import {
  readPublicationVerificationAuditOptions,
  runPublicationVerificationAudit,
} from './audit-publication-delivery-verification';

describe('publication delivery verification audit', () => {
  it('requires a bounded scope and validates limits', () => {
    expect(() => readPublicationVerificationAuditOptions([])).toThrow('bounded --since');
    expect(() =>
      readPublicationVerificationAuditOptions([
        '--since',
        '2026-07-01T00:00:00Z',
        '--limit',
        '201',
      ]),
    ).toThrow('between 1 and 200');
    expect(
      readPublicationVerificationAuditOptions([
        '--since',
        '2026-07-01T00:00:00Z',
        '--until',
        '2026-07-02T00:00:00Z',
        '--limit',
        '20',
        '--json',
      ]),
    ).toEqual(
      expect.objectContaining({
        apply: false,
        json: true,
        limit: 20,
        since: new Date('2026-07-01T00:00:00Z'),
        until: new Date('2026-07-02T00:00:00Z'),
      }),
    );
    expect(() =>
      readPublicationVerificationAuditOptions([
        '--delivery-id',
        'delivery-1',
        '--unverified',
        '--apply',
      ]),
    ).toThrow('read-only');
  });

  it('keeps completed audits read-only and separates range and exact-id modes', () => {
    expect(
      readPublicationVerificationAuditOptions([
        '--since',
        '2026-07-01T00:00:00Z',
        '--until',
        '2026-07-02T00:00:00Z',
        '--unverified',
        '--completed',
      ]),
    ).toEqual(
      expect.objectContaining({
        completed: true,
        unverified: true,
        apply: false,
        deliveryIds: [],
      }),
    );
    expect(
      readPublicationVerificationAuditOptions([
        '--since',
        '2026-07-01T00:00:00Z',
        '--unverified',
        '--terminal',
        '--after',
        '2026-07-01T10:00:00.000Z,delivery-50',
      ]),
    ).toEqual(
      expect.objectContaining({
        terminal: true,
        after: {
          sentAt: new Date('2026-07-01T10:00:00.000Z'),
          deliveryId: 'delivery-50',
        },
      }),
    );
    expect(() =>
      readPublicationVerificationAuditOptions(['--since', '2026-07-01T00:00:00Z', '--completed']),
    ).toThrow('--completed requires --unverified');
    expect(() =>
      readPublicationVerificationAuditOptions([
        '--since',
        '2026-07-01T00:00:00Z',
        '--unverified',
        '--completed',
        '--apply',
      ]),
    ).toThrow('--completed is read-only');
    expect(() =>
      readPublicationVerificationAuditOptions([
        '--delivery-id',
        'delivery-1',
        '--unverified',
        '--completed',
      ]),
    ).toThrow('only in range mode');
    expect(() =>
      readPublicationVerificationAuditOptions([
        '--delivery-id',
        'delivery-1',
        '--since',
        '2026-07-01T00:00:00Z',
        '--unverified',
      ]),
    ).toThrow('cannot be combined');
    expect(() =>
      readPublicationVerificationAuditOptions([
        '--since',
        '2026-07-01T00:00:00Z',
        '--after',
        '2026-07-01T10:00:00.000Z,delivery-50',
      ]),
    ).toThrow('--after requires --unverified range mode');
  });

  it('classifies exact presence without mutating in dry-run mode', async () => {
    const updateMany = jest.fn();
    const prisma = {
      managedBroadcastDelivery: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            candidate({ id: 'delivery-present', remoteMessageId: 'mid-present' }),
          ]),
        updateMany,
      },
    };
    const maxClient = {
      getExactMessagePresences: jest
        .fn()
        .mockResolvedValue([{ chatId: 'chat-1', messageId: 'mid-present', presence: 'present' }]),
    };

    const summary = await runPublicationVerificationAudit(
      prisma as never,
      maxClient as never,
      options({ apply: false }),
    );

    expect(summary).toEqual(
      expect.objectContaining({ selected: 1, present: 1, stableClassifications: 0 }),
    );
    expect(summary.outcomes[0]).toEqual(
      expect.objectContaining({
        classification: PublicationDeliveryVerificationSource.AUTOMATED_STABLE,
        persistence: 'dry_run',
      }),
    );
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('audits an unverified SENT delivery without classifying or mutating it', async () => {
    const updateMany = jest.fn();
    const findMany = jest.fn().mockResolvedValue([
      candidate({
        id: 'delivery-unverified',
        remoteMessageId: 'mid-unverified',
        remoteMessageVerifiedAt: null,
      }),
    ]);
    const prisma = {
      managedBroadcastDelivery: {
        findMany,
        updateMany,
      },
    };
    const maxClient = {
      getExactMessagePresences: jest
        .fn()
        .mockResolvedValue([{ chatId: 'chat-1', messageId: 'mid-unverified', presence: 'absent' }]),
    };

    const summary = await runPublicationVerificationAudit(
      prisma as never,
      maxClient as never,
      options({ unverified: true }),
    );

    expect(summary).toEqual(
      expect.objectContaining({ selected: 1, absent: 1, unverifiedSelected: 1 }),
    );
    expect(summary.outcomes[0]).toEqual(
      expect.objectContaining({
        candidateState: 'unverified',
        classification: null,
        persistence: 'dry_run',
      }),
    );
    expect(updateMany).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          broadcast: {
            is: {
              status: {
                in: [
                  ManagedBroadcastStatus.ACTIVE,
                  ManagedBroadcastStatus.PARTIAL,
                  ManagedBroadcastStatus.FAILED,
                ],
              },
            },
          },
          remoteMessageVerifiedAt: null,
        }),
      }),
    );
  });

  it('audits only completed broadcasts in completed range mode without mutating them', async () => {
    const findMany = jest.fn().mockResolvedValue([
      candidate({
        id: 'delivery-completed',
        remoteMessageId: 'mid-completed',
        remoteMessageVerifiedAt: null,
      }),
    ]);
    const updateMany = jest.fn();
    const prisma = { managedBroadcastDelivery: { findMany, updateMany } };
    const maxClient = {
      getExactMessagePresences: jest
        .fn()
        .mockResolvedValue([{ chatId: 'chat-1', messageId: 'mid-completed', presence: 'present' }]),
    };

    const summary = await runPublicationVerificationAudit(
      prisma as never,
      maxClient as never,
      options({ unverified: true, completed: true }),
    );

    expect(summary).toEqual(
      expect.objectContaining({
        selected: 1,
        present: 1,
        unverifiedSelected: 1,
        requested: 0,
        unmatchedDeliveryIds: [],
      }),
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          broadcast: { is: { status: ManagedBroadcastStatus.COMPLETED } },
          remoteMessageVerifiedAt: null,
        }),
      }),
    );
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('includes completed and canceled broadcasts in terminal range mode', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      managedBroadcastDelivery: { findMany, updateMany: jest.fn() },
    };

    await runPublicationVerificationAudit(
      prisma as never,
      { getExactMessagePresences: jest.fn() } as never,
      options({ unverified: true, terminal: true }),
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          broadcast: {
            is: {
              status: {
                in: [ManagedBroadcastStatus.COMPLETED, ManagedBroadcastStatus.CANCELED],
              },
            },
          },
        }),
      }),
    );
  });

  it('returns a stable cursor and applies it to the next unverified range page', async () => {
    const firstPageRows = [
      candidate({
        id: 'delivery-1',
        sentAt: new Date('2026-07-01T10:00:00.000Z'),
        remoteMessageVerifiedAt: null,
      }),
      candidate({
        id: 'delivery-2',
        sentAt: new Date('2026-07-01T10:00:00.000Z'),
        remoteMessageVerifiedAt: null,
      }),
      candidate({
        id: 'delivery-3',
        sentAt: new Date('2026-07-01T11:00:00.000Z'),
        remoteMessageVerifiedAt: null,
      }),
    ];
    const findMany = jest.fn().mockResolvedValue(firstPageRows);
    const getExactMessagePresences = jest.fn().mockResolvedValue(
      firstPageRows.slice(0, 2).map((row) => ({
        chatId: row.targetChatId,
        messageId: row.remoteMessageId,
        presence: 'present',
      })),
    );

    const firstPage = await runPublicationVerificationAudit(
      { managedBroadcastDelivery: { findMany, updateMany: jest.fn() } } as never,
      { getExactMessagePresences } as never,
      options({ unverified: true, limit: 2 }),
    );

    expect(firstPage.selected).toBe(2);
    expect(firstPage.nextAfter).toBe('2026-07-01T10:00:00.000Z,delivery-2');
    expect(findMany.mock.calls[0]?.[0]?.take).toBe(3);

    findMany.mockResolvedValueOnce([]);
    await runPublicationVerificationAudit(
      { managedBroadcastDelivery: { findMany, updateMany: jest.fn() } } as never,
      { getExactMessagePresences: jest.fn() } as never,
      options({
        unverified: true,
        limit: 2,
        after: {
          sentAt: new Date('2026-07-01T10:00:00.000Z'),
          deliveryId: 'delivery-2',
        },
      }),
    );

    expect(findMany.mock.calls[1]?.[0]?.where.AND).toEqual([
      {
        OR: [
          { sentAt: { gt: new Date('2026-07-01T10:00:00.000Z') } },
          {
            sentAt: new Date('2026-07-01T10:00:00.000Z'),
            id: { gt: 'delivery-2' },
          },
        ],
      },
    ]);
  });

  it('does not truncate exact IDs, bypasses broadcast status, and reports unmatched IDs', async () => {
    const deliveryIds = Array.from({ length: 75 }, (_, index) => `delivery-${index + 1}`);
    const selectedIds = deliveryIds.slice(0, -1);
    const rows = selectedIds.map((id, index) =>
      candidate({
        id,
        remoteMessageId: `mid-${index + 1}`,
        remoteMessageVerifiedAt: null,
      }),
    );
    const findMany = jest.fn().mockResolvedValue(rows);
    const updateMany = jest.fn();
    const getExactMessagePresences = jest.fn().mockResolvedValue(
      rows.map((row) => ({
        chatId: row.targetChatId,
        messageId: row.remoteMessageId,
        presence: 'present',
      })),
    );
    const prisma = { managedBroadcastDelivery: { findMany, updateMany } };

    const summary = await runPublicationVerificationAudit(
      prisma as never,
      { getExactMessagePresences } as never,
      options({
        unverified: true,
        since: null,
        deliveryIds,
        limit: 1,
      }),
    );

    const query = findMany.mock.calls[0]?.[0];
    expect(query.take).toBe(75);
    expect(query.where).toEqual(
      expect.objectContaining({
        id: { in: deliveryIds },
        remoteMessageVerifiedAt: null,
      }),
    );
    expect(query.where).not.toHaveProperty('broadcast');
    expect(summary).toEqual(
      expect.objectContaining({
        selected: 74,
        requested: 75,
        unmatchedDeliveryIds: ['delivery-75'],
      }),
    );
    expect(getExactMessagePresences).toHaveBeenCalledWith(
      expect.arrayContaining(
        rows.map((row) => ({ chatId: row.targetChatId, messageId: row.remoteMessageId })),
      ),
      expect.any(Object),
    );
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('applies stable and honest legacy classifications without changing delivery status', async () => {
    const rows = [
      candidate({ id: 'delivery-present', remoteMessageId: 'mid-present' }),
      candidate({ id: 'delivery-absent', remoteMessageId: 'mid-absent' }),
      candidate({ id: 'delivery-error', remoteMessageId: 'mid-error' }),
      candidate({ id: 'delivery-no-bot', remoteMessageId: 'mid-no-bot', botId: null }),
    ];
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      managedBroadcastDelivery: { findMany: jest.fn().mockResolvedValue(rows), updateMany },
    };
    const maxClient = {
      getExactMessagePresences: jest.fn().mockResolvedValue([
        { chatId: 'chat-1', messageId: 'mid-present', presence: 'present' },
        { chatId: 'chat-1', messageId: 'mid-absent', presence: 'absent' },
        { chatId: 'chat-1', messageId: 'mid-error', error: new Error('lookup failed') },
      ]),
    };

    const summary = await runPublicationVerificationAudit(
      prisma as never,
      maxClient as never,
      options({ apply: true }),
    );

    expect(summary).toEqual(
      expect.objectContaining({
        selected: 4,
        present: 1,
        absent: 1,
        errors: 1,
        noBot: 1,
        stableClassifications: 1,
        legacyClassifications: 3,
      }),
    );
    expect(updateMany).toHaveBeenCalledTimes(4);
    expect(updateMany.mock.calls.every(([query]) => query.data.status === undefined)).toBe(true);
    expect(
      updateMany.mock.calls.map(([query]) => query.data.remoteMessageVerificationSource),
    ).toEqual([
      PublicationDeliveryVerificationSource.AUTOMATED_STABLE,
      PublicationDeliveryVerificationSource.LEGACY_SINGLE_OBSERVATION,
      PublicationDeliveryVerificationSource.LEGACY_SINGLE_OBSERVATION,
      PublicationDeliveryVerificationSource.LEGACY_SINGLE_OBSERVATION,
    ]);
  });
});

function options(
  overrides: Partial<ReturnType<typeof readPublicationVerificationAuditOptions>>,
): ReturnType<typeof readPublicationVerificationAuditOptions> {
  return {
    apply: false,
    json: false,
    limit: 50,
    since: new Date('2026-07-01T00:00:00Z'),
    until: null,
    deliveryIds: [],
    unverified: false,
    completed: false,
    terminal: false,
    after: null,
    ...overrides,
  };
}

function candidate(
  overrides: Partial<{
    id: string;
    remoteMessageId: string;
    botId: string | null;
    remoteMessageVerifiedAt: Date | null;
    sentAt: Date;
  }> = {},
) {
  return {
    id: overrides.id ?? 'delivery-1',
    broadcastId: 'broadcast-1',
    occurrenceIndex: 1,
    targetChatId: 'chat-1',
    botId: overrides.botId === undefined ? 'bot-1' : overrides.botId,
    status: ManagedBroadcastDeliveryStatus.SENT,
    sentAt: overrides.sentAt ?? new Date('2026-07-01T00:00:00Z'),
    remoteMessageId: overrides.remoteMessageId ?? 'mid-1',
    remoteMessageVerifiedAt:
      overrides.remoteMessageVerifiedAt === undefined
        ? new Date('2026-07-01T00:00:00Z')
        : overrides.remoteMessageVerifiedAt,
    remoteMessageVerificationAttemptCount: 0,
    remoteMessageVerificationAbsentCount: 0,
    remoteMessageVerificationPresentCount: 0,
    remoteMessageVerificationAttemptedAt: null,
    remoteMessageVerificationNextAt: null,
    remoteMessageVerificationLastError: null,
  };
}
