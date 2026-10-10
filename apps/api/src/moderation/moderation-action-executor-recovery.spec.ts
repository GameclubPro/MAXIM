import { ModerationService } from './moderation.service';
import { markMaxPreDispatchGuardRejected } from '../max/max-action-pre-dispatch-guard';
import { markMaxMessageSendAttempted } from '../max/max-mutation-outcome.util';
import { markMaxMemberMutationAttempted } from '../max/max-member-error.util';

function fixture() {
  const service = Object.assign(Object.create(ModerationService.prototype), {
    resolveModerationActionBotIds: jest.fn(async () => ['first', 'second']),
    isModerationActionBotBackoffActive: jest.fn(async () => false),
    clearModerationActionBotBackoff: jest.fn(async () => undefined),
    rememberModerationActionBotBackoff: jest.fn(async () => undefined),
    recordModerationActionProblemChat: jest.fn(async () => undefined),
    recordModerationActionAccessLossIfTerminal: jest.fn(async () => undefined),
    recordModerationActionNoCandidateProblemChat: jest.fn(async () => undefined),
    runtimeDiagnosticsService: { recordHotPathStageOutcome: jest.fn() },
  });
  const error = Object.assign(new Error('MAX action executor proof changed during quota wait'), {
    code: 'max_action_executor_proof_rejected',
  });
  return {
    service,
    error,
    run: (operation: (bot?: string) => Promise<void>, action = 'delete_message') =>
      service.executeModerationActionWithFallbackResult({
        chatId: '-123',
        messageId: 'source',
        action,
        operation,
      }),
  };
}

describe('legacy DELETE executor proof recovery', () => {
  it('tries the next candidate only after a genuine refusal before dispatch', async () => {
    const s = fixture();
    const error = markMaxPreDispatchGuardRejected(s.error, 'unused');
    const operation = jest.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    await expect(s.run(operation)).resolves.toEqual({ ok: true, botId: 'second' });
    expect(operation.mock.calls).toEqual([['first'], ['second']]);
    expect(s.service.recordModerationActionAccessLossIfTerminal).not.toHaveBeenCalled();
    expect(s.service.rememberModerationActionBotBackoff).not.toHaveBeenCalled();
  });
  it('finishes a bounded all-refused pass without a false DELETE or permissions result', async () => {
    const s = fixture();
    const operation = jest
      .fn()
      .mockRejectedValue(markMaxPreDispatchGuardRejected(s.error, 'unused'));
    await expect(s.run(operation)).resolves.toEqual({ ok: false, botId: null });
    expect(operation).toHaveBeenCalledTimes(2);
    expect(s.service.recordModerationActionNoCandidateProblemChat).not.toHaveBeenCalled();
    expect(s.service.recordModerationActionProblemChat).not.toHaveBeenCalled();
  });
  it.each([
    'unmarked',
    'send-attempted',
    'member-attempted',
    'ambiguous',
    'wrong-code',
    'member-action',
  ])('keeps %s errors fenced', async (kind) => {
    const s = fixture();
    const error =
      kind === 'unmarked' ? s.error : markMaxPreDispatchGuardRejected(s.error, 'unused');
    if (kind === 'send-attempted') markMaxMessageSendAttempted(error);
    if (kind === 'member-attempted') markMaxMemberMutationAttempted(error);
    if (kind === 'ambiguous') Object.assign(error as object, { response: { status: 503 } });
    if (kind === 'wrong-code') Object.assign(error as object, { code: 'other' });
    const operation = jest.fn().mockRejectedValue(error);
    await expect(
      s.run(operation, kind === 'member-action' ? 'moderate_member' : 'delete_message'),
    ).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
