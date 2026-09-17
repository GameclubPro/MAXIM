import {
  executeDurableModerationDelete,
  executeGuardedModerationDelete,
} from './moderation-delete-execution';

describe('commercial durable deletion proof', () => {
  it('refuses delayed legacy dispatch even without an explicit executeAt', async () => {
    const legacyExecute = jest.fn();
    await expect(
      executeGuardedModerationDelete({
        input: {
          chatId: 'chat',
          messageId: 'message',
          reasonKey: 'reason',
          ruleCode: 'COMMERCIAL_AD_DELETE',
        },
        options: { delayMs: 1000 },
        commercialGuard: { assertMessageStillActionable: jest.fn() },
        legacyExecute,
        logger: { warn: jest.fn() },
      }),
    ).rejects.toThrow('durable guarded executor');
    expect(legacyExecute).not.toHaveBeenCalled();
  });
  it.each([
    ['requested', true],
    ['another-revision', false],
  ])('does not transfer proof from reason %s', async (verifiedKey, expected) => {
    const result = await executeDurableModerationDelete({
      input: {
        chatId: 'chat',
        messageId: 'message',
        reasonKey: 'requested',
        ruleCode: 'COMMERCIAL_AD_DELETE',
      },
      service: {
        getRolloutForInput: () => 'execute',
        ensureAndAttempt: async () => ({
          kind: 'confirmed',
          confirmed: true,
          intentId: 'intent',
          status: 'SUCCEEDED',
          botId: 'bot',
          commercialVerified: true,
          commercialVerifiedReasonKeys: [verifiedKey as string],
        }),
      },
      legacy: jest.fn(),
      logger: { warn: jest.fn() },
    });
    expect(result.commercialVerified === true).toBe(expected);
  });
});
