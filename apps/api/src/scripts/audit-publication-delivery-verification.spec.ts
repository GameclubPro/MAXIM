import {
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
    const prisma = {
      managedBroadcastDelivery: {
        findMany: jest.fn().mockResolvedValue([
          candidate({
            id: 'delivery-unverified',
            remoteMessageId: 'mid-unverified',
            remoteMessageVerifiedAt: null,
          }),
        ]),
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
    ...overrides,
  };
}

function candidate(
  overrides: Partial<{
    id: string;
    remoteMessageId: string;
    botId: string | null;
    remoteMessageVerifiedAt: Date | null;
  }> = {},
) {
  return {
    id: overrides.id ?? 'delivery-1',
    broadcastId: 'broadcast-1',
    occurrenceIndex: 1,
    targetChatId: 'chat-1',
    botId: overrides.botId === undefined ? 'bot-1' : overrides.botId,
    status: ManagedBroadcastDeliveryStatus.SENT,
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
