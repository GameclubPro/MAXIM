import { SafetyDeskRetentionService } from './safety-desk-retention.service';
import type { SafetyDeskRetentionRuntimeResponse } from '@maxim/contracts/safety-desk';
import type { EraserControlService } from '../message-retention/eraser-control.service';
import type { LegacyRuntimeBatch, RetentionRuntimePageRow } from './safety-desk-retention-queries';
import type { PrismaService } from '../prisma/prisma.service';

function setup() {
  const query: jest.MockedFunction<PrismaService['$queryRaw']> = jest
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ diagnostics: [], quotas: [] } satisfies LegacyRuntimeBatch]);
  const prisma = {
    $queryRaw: query,
    messageRetentionPolicy: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    messageRetentionQuota: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const store = {
    allows: jest.fn().mockReturnValue(true),
    mode: 'off',
  };
  const service = new SafetyDeskRetentionService(prisma as never, store as never);
  const body = {
    messageId: 'mid',
    activationId: 'activation',
    expectedRevision: 5,
    intentId: 'intent',
    expectedIntentUpdatedAt: '2026-10-01T10:00:00.000Z',
    expectedAttemptCount: 3,
  };
  return { service, prisma, store, body };
}
describe('closed retention operator boundary', () => {
  it('preserves native diagnostic flags while redacting an unknown upstream error', async () => {
    const runtime: SafetyDeskRetentionRuntimeResponse = {
      generatedAt: '2026-10-28T10:00:00.000Z',
      mode: 'on',
      nextAfter: null,
      quotas: [],
      items: [
        {
          chatId: '-123',
          chatTitle: '',
          enabled: true,
          hours: 48,
          revision: 1,
          activationId: 'activation-1',
          pendingCount: 0,
          deletedCount: 0,
          skippedCount: 0,
          status: 'delayed',
          oldestDueAt: null,
          nextRunAt: null,
          hasTerminalReview: false,
          hasUnresolvedReceipt: true,
          historyStatus: 'blocked',
          diagnostics: {
            lastError: null,
            historyBoundaryBlocked: false,
            awaitingCurrentProtection: false,
            awaitingHistoricalProtection: true,
          },
        },
      ],
    };
    const eraser: jest.Mocked<Pick<EraserControlService, 'enabled' | 'request'>> = {
      enabled: true,
      request: jest.fn().mockResolvedValue({
        ...runtime,
        items: runtime.items.map((item) => ({
          ...item,
          diagnostics: { ...item.diagnostics, lastError: 'private-upstream-detail' },
        })),
      }),
    };
    const { prisma, store } = setup();
    prisma.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([
        { chatId: '-123', chatTitle: 'Чат', source: 'eraser' } satisfies RetentionRuntimePageRow,
      ])
      .mockResolvedValueOnce([{ diagnostics: [], quotas: [] } satisfies LegacyRuntimeBatch]);
    const service = new SafetyDeskRetentionService(
      prisma as unknown as PrismaService,
      store as never,
      eraser as unknown as EraserControlService,
    );

    const result = await service.runtime();

    expect(result.items[0]).toMatchObject({
      chatTitle: 'Чат',
      hasUnresolvedReceipt: true,
      historyStatus: 'blocked',
      diagnostics: { ...runtime.items[0]!.diagnostics, lastError: 'unknown' },
    });
    expect(JSON.stringify(result)).not.toContain('private-upstream-detail');
    expect(eraser.request).toHaveBeenCalledWith('/runtime?chatIds=-123');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('forwards opaque Lastik review cursors and exact microsecond retry versions', async () => {
    const { prisma, store, body } = setup();
    const preview = {
      chatId: '-1',
      revision: 5,
      activationId: 'activation',
      source: 'eraser',
      sourceStatus: 'available',
      items: [],
      nextAfter: null,
    };
    const eraser: jest.Mocked<
      Pick<EraserControlService, 'enabled' | 'owns' | 'request' | 'protectionReport'>
    > = {
      enabled: false,
      owns: jest.fn().mockResolvedValue(true),
      request: jest.fn().mockResolvedValue(preview),
      protectionReport: jest.fn().mockResolvedValue({ status: 'unavailable' }),
    };
    const service = new SafetyDeskRetentionService(
      prisma as unknown as PrismaService,
      store as never,
      eraser as unknown as EraserControlService,
    );
    const cursor = Buffer.from(
      JSON.stringify({
        version: 1,
        source: 'eraser',
        chatId: '-1',
        revision: 5,
        activationId: 'activation',
        messageId: 'mid',
      }),
    ).toString('base64url');
    await service.preview('-1', cursor);
    expect(eraser.request).toHaveBeenCalledWith(`/chats/-1/review?after=${cursor}`);
    await service.retry('-1', 'operator', {
      ...body,
      expectedIntentUpdatedAt: '2026-10-29T10:01:02.123456Z',
    });
    expect(eraser.request).toHaveBeenLastCalledWith(
      '/chats/-1/retry',
      'POST',
      expect.objectContaining({
        expectedIntentUpdatedAt: '2026-10-29T10:01:02.123456Z',
        actorUserId: 'operator',
      }),
    );
  });

  it('rejects an unowned legacy retry even when Lastik onboarding is enabled', async () => {
    const { prisma, store, body } = setup();
    const eraser: jest.Mocked<Pick<EraserControlService, 'enabled' | 'owns' | 'request'>> = {
      enabled: true,
      owns: jest.fn().mockResolvedValue(false),
      request: jest.fn(),
    };
    const service = new SafetyDeskRetentionService(
      prisma as unknown as PrismaService,
      store as never,
      eraser as unknown as EraserControlService,
    );
    await expect(service.retry('-1', 'operator', body)).rejects.toMatchObject({ status: 400 });
    expect(eraser.request).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('uses two bounded queries for an empty legacy page', async () => {
    const { service, prisma } = setup();
    await expect(service.runtime('-123')).resolves.toMatchObject({
      items: [],
      nextAfter: null,
      mode: 'off',
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('refuses invalid identifiers and unknown input before reads or access probes', async () => {
    const { service, body, prisma } = setup();
    await expect(service.runtime('bad')).rejects.toMatchObject({ status: 400 });
    await expect(service.retry('-1', 'owner', { ...body, force: true })).rejects.toMatchObject({
      status: 400,
    });
    expect(prisma.messageRetentionPolicy.findMany).not.toHaveBeenCalled();
  });
  it('never reopens a historical Major journal without an owned Lastik source', async () => {
    const { service, body, prisma } = setup();
    await expect(service.retry('-1', 'owner', body)).rejects.toMatchObject({ status: 400 });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
