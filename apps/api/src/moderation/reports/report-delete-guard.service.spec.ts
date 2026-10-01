import { ReportDeleteGuardService } from './report-delete-guard.service';
import {
  REPORT_COUNTER_RULE,
  REPORT_DELETE_RULE,
  ReportRejectedError,
  ReportStaleStateError,
} from './report.util';

const current = {
  id: 'case-b',
  chatId: 'chat',
  messageId: 'target',
  authorId: 'author',
  contentVersion: 1,
  contentHash: 'hash',
  status: 'RUNNING',
  originBotId: 'bot',
};
function fixture(reasons: Array<{ ruleCode: string; metadata: unknown }>) {
  const state = {
    assertCase: jest.fn(async (id: string) => {
      if (id === 'case-a') throw new ReportRejectedError('revoked');
      return current;
    }),
    source: jest.fn().mockResolvedValue({ hash: 'hash', authorId: 'author' }),
    assertVoters: jest.fn(),
    assertLocalAuthor: jest.fn(),
    assertCurrent: jest.fn().mockResolvedValue(current),
    assertPolicy: jest.fn(),
    settings: jest.fn().mockResolvedValue({ deleteBotMessagesEnabled: true }),
  };
  const prisma = {
    moderationDeleteIntentReason: { findMany: jest.fn().mockResolvedValue(reasons) },
    chatReportCase: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUniqueOrThrow: jest.fn().mockResolvedValue(current),
    },
    chatReportAction: { findUnique: jest.fn().mockResolvedValue({ intentId: 'intent' }) },
  };
  return {
    state,
    prisma,
    guard: new ReportDeleteGuardService(state as never, prisma as never, {} as never),
  };
}
const params = {
  intentId: 'intent',
  chatId: 'chat',
  messageId: 'target',
  subjectUserId: 'author',
  botId: 'bot',
};
const reason = (id: string) => ({
  ruleCode: REPORT_DELETE_RULE,
  metadata: { reportCaseId: id, contentVersion: 1 },
});
describe('report deletion authority', () => {
  it.each([false, true])(
    'uses the remaining current case independently of reason order=%s',
    async (reverse) => {
      const reasons = [reason('case-a'), reason('case-b')];
      const { guard } = fixture(reverse ? reasons.reverse() : reasons);
      await expect(guard.assertIntentStillActionable(params)).resolves.toBe('allowed');
    },
  );
  it('settles only after all report authorities are definitively revoked', async () => {
    const { guard, state } = fixture([reason('case-a'), reason('case-b')]);
    state.assertCase.mockRejectedValue(new ReportRejectedError('revoked'));
    await expect(guard.assertIntentStillActionable(params)).rejects.toBeInstanceOf(
      ReportRejectedError,
    );
    expect(state.assertCase).toHaveBeenCalledTimes(2);
  });
  it('preserves a retryable unknown state when another case is revoked', async () => {
    const { guard, state } = fixture([reason('case-a'), reason('case-b')]);
    state.assertCase
      .mockRejectedValueOnce(new ReportRejectedError('revoked'))
      .mockRejectedValueOnce(new ReportStaleStateError('changed'));
    await expect(guard.assertIntentStillActionable(params)).rejects.toBeInstanceOf(
      ReportStaleStateError,
    );
  });
  it.each([
    { codes: ['BOT_MESSAGE_AUTO_DELETE'] },
    { codes: [REPORT_COUNTER_RULE, 'BOT_MESSAGE_AUTO_DELETE'] },
  ])('protects a reopened counter with generic reasons %j', async ({ codes }) => {
    const { guard, prisma, state } = fixture(
      codes.map((ruleCode) => ({ ruleCode, metadata: { reportCaseId: current.id } })),
    );
    prisma.chatReportCase.findFirst.mockResolvedValue({
      ...current,
      counterMessageId: 'target',
    } as never);
    await expect(guard.assertIntentStillActionable(params)).rejects.toBeInstanceOf(
      ReportStaleStateError,
    );
    expect(state.assertCase).not.toHaveBeenCalled();
  });
  it('allows generic cleanup of a genuinely finished exact-owner counter while admission is disabled', async () => {
    const { guard, prisma, state } = fixture([
      { ruleCode: 'BOT_MESSAGE_AUTO_DELETE', metadata: {} },
    ]);
    prisma.chatReportCase.findFirst.mockResolvedValue({
      ...current,
      counterMessageId: 'target',
      status: 'CANCELLED',
    } as never);
    await expect(guard.assertIntentStillActionable(params)).resolves.toBe('not_applicable');
    expect(state.assertCurrent).toHaveBeenCalled();
  });
  it('refuses the target after it changes during final voter reads', async () => {
    const { guard, state } = fixture([reason('case-b')]);
    state.assertCurrent.mockRejectedValue(new ReportStaleStateError('changed'));
    await expect(guard.assertIntentStillActionable(params)).rejects.toBeInstanceOf(
      ReportStaleStateError,
    );
  });
  it.each([false, true])(
    'ignores dormant independent reasons while evaluating revoked reports, reversed=%s',
    async (reverse) => {
      const reasons = [reason('case-a'), { ruleCode: 'ANTI_SPAM', metadata: {} }];
      const { guard, state } = fixture(reverse ? reasons.reverse() : reasons);
      await expect(
        guard.assertIntentStillActionable({
          ...params,
          isIndependentReasonExecutable: () => false,
        }),
      ).rejects.toBeInstanceOf(ReportRejectedError);
      expect(state.assertCase).toHaveBeenCalledTimes(1);
    },
  );
  it('preserves executable independent authority after report revocation', async () => {
    const { guard, state } = fixture([reason('case-a'), { ruleCode: 'ANTI_SPAM', metadata: {} }]);
    const isIndependentReasonExecutable = jest.fn().mockReturnValue(true);
    await expect(
      guard.assertIntentStillActionable({ ...params, isIndependentReasonExecutable }),
    ).resolves.toBe('not_applicable');
    expect(isIndependentReasonExecutable).toHaveBeenCalledWith([
      { ruleCode: 'ANTI_SPAM', metadata: {} },
    ]);
    expect(state.assertCase).not.toHaveBeenCalled();
  });
});
