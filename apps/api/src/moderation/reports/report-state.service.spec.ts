import { ReportStateService } from './report-state.service';
import { ReportRejectedError, ReportStaleStateError } from './report.util';

describe('report runtime authority', () => {
  it.each([
    [undefined, '', 'chat', false],
    ['off', '', 'chat', false],
    ['canary', 'allowed, second', 'chat', false],
    ['canary', 'allowed, second', 'second', true],
    ['on', '', 'chat', true],
    ['invalid', '', 'chat', false],
  ])(
    'resolves mode %s for the exact chat without broadening canary scope',
    (mode, ids, chat, expected) => {
      const state = new ReportStateService(
        {} as never,
        {} as never,
        {} as never,
        {
          get: (key: string) => (key === 'PARTICIPANT_REPORTS_MODE' ? mode : ids),
        } as never,
      );
      expect(state.enabled(chat)).toBe(expected);
    },
  );

  const report = {
    id: 'case',
    status: 'RUNNING',
    contentVersion: 1,
    contentHash: 'hash',
    policyRevision: 3,
    authorId: 'author',
    messageId: 'target',
    decidedAt: new Date(1000),
  };
  it.each([
    { status: 'DISMISSED' },
    { contentVersion: 2 },
    { contentHash: 'changed' },
    { policyRevision: 4 },
    { authorId: 'other' },
    { decidedAt: new Date(2000) },
  ])('rejects a state changed during remote checks: %j', async (change) => {
    const state = new ReportStateService(
      {
        chatReportCase: { findUnique: jest.fn().mockResolvedValue({ ...report, ...change }) },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(
      state.assertCurrent(report as never, ['RUNNING', 'PENDING']),
    ).rejects.toBeInstanceOf(ReportStaleStateError);
  });

  it.each([undefined, null, 0, -1, '2026-10-01T12:00:00Z', 'broken', Infinity, NaN, 1.5])(
    'requires the original MAX timestamp without an ingress fallback: %s',
    async (timestamp) => {
      const max = {
        getExactMessageRow: jest.fn().mockResolvedValue({
          sender: { user_id: 'author', is_bot: false },
          recipient: { chat_id: 'chat', chat_type: 'chat' },
          timestamp,
          body: { mid: 'target', text: 'text' },
        }),
      };
      const state = new ReportStateService({} as never, max as never, {} as never, {} as never);
      await expect(state.source('chat', 'target', 'bot')).rejects.toBeInstanceOf(
        ReportRejectedError,
      );
    },
  );
  it('keeps MAX milliseconds as creation time rather than parser normalization', async () => {
    const timestamp = 1_700_000_000;
    const state = new ReportStateService(
      {} as never,
      {
        getExactMessageRow: async () => ({
          sender: { user_id: 'author', is_bot: false },
          recipient: { chat_id: 'chat', chat_type: 'chat' },
          timestamp,
          body: { mid: 'target', text: 'text' },
        }),
      } as never,
      {} as never,
      {} as never,
    );
    expect((await state.source('chat', 'target', 'bot'))!.createdAt.getTime()).toBe(timestamp);
  });
  it('honors absolute fanout expiry and ignores an invalidated sanction', async () => {
    const event = {
      id: 'event',
      action: 'MUTE',
      ruleCode: 'MANUAL_MUTE',
      createdAt: new Date(Date.now() - 20 * 60_000),
      metadata: {
        muteDurationHours: 1,
        muteExpiresAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      },
    };
    const prisma = { moderationEvent: { findFirst: jest.fn().mockResolvedValue(event) } };
    const fences = { isSanctionEventInvalidated: jest.fn().mockResolvedValue(false) };
    const state = new ReportStateService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      fences as never,
    );
    expect(await state.hasActiveSanction('chat', 'author')).toBe(false);
    event.metadata.muteExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    expect(await state.hasActiveSanction('chat', 'author')).toBe(true);
    fences.isSanctionEventInvalidated.mockResolvedValue(true);
    expect(await state.hasActiveSanction('chat', 'author')).toBe(false);
    expect(fences.isSanctionEventInvalidated).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sanctionEventId: 'event',
        chatId: 'chat',
        userId: 'author',
      }),
      prisma,
    );
  });
  it.each([undefined, 'background'] as const)(
    'checks author authority on the selected traffic class without broadening protection: %s',
    async (trafficClass) => {
      const current = { ...report, chatId: 'chat', decidedAt: new Date() };
      const max = {
        getExactMessageRow: jest.fn(),
        getChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'author',
          isBot: false,
          isAdmin: false,
          isOwner: false,
        }),
      };
      const state = new ReportStateService(
        {
          chatReportCase: {
            findUniqueOrThrow: jest.fn().mockResolvedValue(current),
            findUnique: jest.fn().mockResolvedValue(current),
          },
          chatSettings: {
            findUnique: jest.fn().mockResolvedValue({
              reportsEnabled: true,
              reportsRevision: current.policyRevision,
              chat: { entityType: 'CHAT', admins: [] },
            }),
          },
          chatParticipantModerationImmunity: { findFirst: jest.fn().mockResolvedValue(null) },
        } as never,
        max as never,
        { isKnownBotUserId: () => false } as never,
        { get: () => 'on' } as never,
      );
      expect(await state.assertCase('case', 'bot', false, trafficClass)).toEqual(current);
      expect(max.getChatMemberAccess).toHaveBeenLastCalledWith(
        'chat',
        'author',
        expect.objectContaining({ bypassCache: true, trafficClass: trafficClass ?? 'critical' }),
      );
      expect(max.getExactMessageRow).not.toHaveBeenCalled();
      max.getChatMemberAccess.mockResolvedValue({
        userId: 'author',
        isBot: false,
        isAdmin: true,
        isOwner: false,
      });
      await expect(state.assertCase('case', 'bot', false, trafficClass)).rejects.toBeInstanceOf(
        ReportRejectedError,
      );
    },
  );
});
