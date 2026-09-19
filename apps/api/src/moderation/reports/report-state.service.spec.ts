import { ReportStateService } from './report-state.service';
import { ReportStaleStateError } from './report.util';

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
});
