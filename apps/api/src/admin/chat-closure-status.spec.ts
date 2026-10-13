import { DEFAULT_CHAT_SETTINGS } from './admin.service.support';
import { readChatClosureStatus } from './chat-closure-status';

describe('saved closure diagnostics', () => {
  const now = new Date('2026-10-13T21:30:00Z');
  const settings = {
    ...DEFAULT_CHAT_SETTINGS,
    nightModeEnabled: true,
    nightModeBotMessageEnabled: true,
    nightModeStartTimeMinutes: 23 * 60,
    nightModeEndTimeMinutes: 8 * 60,
    nightModeTimezone: 'Europe/Moscow',
  };
  function harness(permissions = ['read_all_messages', 'write'], entityType = 'CHAT') {
    return {
      chat: {
        findUnique: jest
          .fn()
          .mockResolvedValue({
            id: 'chat',
            entityType,
            routingState: 'READY',
            routingVersion: 1,
            primaryBotId: 'bot',
            botMemberships: [
              {
                botId: 'bot',
                status: 'ACTIVE',
                botAccessState: 'CONFIRMED_ADMIN',
                botAccessCheckedAt: new Date('2020-01-01'),
                botAccessExpiresAt: null,
                botAccessSource: 'handshake_start',
                permissionsSnapshot: {
                  isAdmin: true,
                  isOwner: false,
                  permissionsKnown: true,
                  permissions,
                  checkedAt: '2020-01-01T00:00:00.000Z',
                },
              },
            ],
          }),
      },
      nightModeTransitionReconcileRequest: { findUnique: jest.fn().mockResolvedValue(null) },
      maxActionLedgerEntry: { findUnique: jest.fn().mockResolvedValue(null) },
    };
  }
  it('keeps chat deletion available with durable write access without a notice receipt', async () => {
    expect(
      await readChatClosureStatus(harness() as never, 'chat', settings, ['bot'], now),
    ).toMatchObject({
      restriction: 'night',
      scheduleEnabled: true,
      deleteRoute: 'available',
      notice: 'not_recorded',
      opensAt: '2026-10-14T05:00:00.000Z',
    });
  });
  it('does not mistake channel send permission for delete authority', async () => {
    expect(
      (
        await readChatClosureStatus(
          harness(['read_all_messages', 'write'], 'CHANNEL') as never,
          'chat',
          settings,
          ['bot'],
          now,
        )
      ).deleteRoute,
    ).toBe('unavailable');
  });
  it.each(['SUCCEEDED', 'AMBIGUOUS', 'ENQUEUED'] as const)(
    'shows the distinct %s notice result',
    async (state) => {
      const prisma = harness();
      prisma.maxActionLedgerEntry.findUnique.mockResolvedValue({
        chatId: 'chat',
        actionType: 'SEND_MESSAGE',
        sourceTag: 'night_mode_transition',
        status: state,
        terminal: state === 'SUCCEEDED',
        ambiguous: state === 'AMBIGUOUS',
        attemptCount: state === 'ENQUEUED' ? 0 : 1,
        remoteMessageId: state === 'SUCCEEDED' ? 'receipt' : null,
        dispatchBotId: 'bot',
        completedAt: now,
      });
      expect(
        (await readChatClosureStatus(prisma as never, 'chat', settings, ['bot'], now)).notice,
      ).toBe(state === 'SUCCEEDED' ? 'delivered' : state === 'AMBIGUOUS' ? 'unknown' : 'pending');
    },
  );
  it('keeps manual closure active until an overlapping night interval ends', async () => {
    const manual = {
      ...settings,
      nightModeForceCloseEnabled: true,
      nightModeForceCloseForever: false,
      nightModeForceCloseUntil: '2026-10-14T00:00:00Z',
    };
    expect(
      await readChatClosureStatus(harness() as never, 'chat', manual, ['bot'], now),
    ).toMatchObject({ restriction: 'manual', opensAt: '2026-10-14T05:00:00.000Z' });
  });
  it('preserves the legacy all-day restriction without inventing an opening time', async () => {
    expect(
      await readChatClosureStatus(
        harness() as never,
        'chat',
        { ...settings, nightModeEndTimeMinutes: settings.nightModeStartTimeMinutes },
        ['bot'],
        now,
      ),
    ).toMatchObject({ restriction: 'night', opensAt: null, notice: 'unknown' });
  });
  it('does not show a stale manual block for a newer recovery generation', async () => {
    const prisma = harness();
    prisma.nightModeTransitionReconcileRequest.findUnique.mockResolvedValue({
      firstRequestedAt: now,
      manualBlockedAt: now,
      generation: 2n,
      manualBlockedGeneration: 1n,
    });
    expect(
      (await readChatClosureStatus(prisma as never, 'chat', settings, ['bot'], now)).recovery,
    ).toBe('waiting');
  });
  it('keeps the saved restriction visible when all diagnostics stores fail', async () => {
    const prisma = harness();
    for (const model of Object.values(prisma))
      model.findUnique.mockRejectedValue(new Error('database unavailable'));
    expect(
      await readChatClosureStatus(prisma as never, 'chat', settings, ['bot'], now),
    ).toMatchObject({
      restriction: 'night',
      deleteRoute: 'unknown',
      notice: 'unknown',
      recovery: 'unknown',
    });
  });
});
