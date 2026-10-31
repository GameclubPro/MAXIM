import {
  executeDurableModerationDelete,
  executeGuardedModerationDelete,
  prepareModerationDeleteIntentInput,
  type ModerationDeleteExecutionOptions,
} from './moderation-delete-execution';

describe('moderation delete execution boundaries', () => {
  it('keeps durable source qualification phases outside the legacy transport adapter', async () => {
    const beforeImmediateDeleteMutation = jest.fn<
      ReturnType<NonNullable<ModerationDeleteExecutionOptions['beforeImmediateDeleteMutation']>>,
      Parameters<NonNullable<ModerationDeleteExecutionOptions['beforeImmediateDeleteMutation']>>
    >();
    const legacyExecute = jest.fn();
    await executeGuardedModerationDelete({
      input: { chatId: 'chat', messageId: 'message', reasonKey: 'duplicate' },
      options: { beforeImmediateDeleteMutation },
      service: {
        getRolloutForInput: () => 'execute',
        ensureAndAttempt: async (_input, options) => {
          expect(options?.beforeDeleteMutation).toBe(beforeImmediateDeleteMutation);
          await options?.beforeDeleteMutation?.('initial_unattempted');
          await options?.beforeDeleteMutation?.('recheck');
          return { kind: 'pending', confirmed: false, intentId: 'intent', status: 'RETRYABLE' };
        },
      },
      legacyExecute,
      logger: { warn: jest.fn() },
    });
    expect(beforeImmediateDeleteMutation.mock.calls).toEqual([
      ['initial_unattempted'],
      ['recheck'],
    ]);
    expect(legacyExecute).not.toHaveBeenCalled();
  });

  it('retains legacy routing while keeping its checkpoint outside the durable phase callback', async () => {
    const beforeImmediateDeleteMutation = jest.fn().mockResolvedValue(undefined);
    const checkpoint = jest.fn().mockResolvedValue(undefined);
    await executeGuardedModerationDelete({
      input: { chatId: 'chat', messageId: 'message', reasonKey: 'duplicate' },
      options: { botId: 'original-bot', trafficClass: 'critical', beforeImmediateDeleteMutation },
      legacyExecute: async (_hooks, options) => {
        expect(options).toEqual({
          botId: 'original-bot',
          trafficClass: 'critical',
          beforeImmediateDeleteMutation: expect.any(Function),
        });
        await options?.beforeImmediateDeleteMutation?.(checkpoint);
        return { ok: true, botId: 'original-bot' };
      },
      logger: { warn: jest.fn() },
    });
    expect(beforeImmediateDeleteMutation.mock.calls).toEqual([[]]);
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it('preserves an original source and explicit execution time across delayed preparation', () => {
    const input = {
      chatId: 'chat',
      messageId: 'message',
      reasonKey: 'reason',
      sourceMessageAt: new Date('2026-10-31T04:00:00.000Z'),
      executeAt: new Date('2026-10-31T04:01:00.000Z'),
      originBotId: 'original-bot',
      routingPolicy: 'origin_only' as const,
    };
    const result = prepareModerationDeleteIntentInput(input, 'current-bot', { delayMs: 60_000 });
    expect(result).toMatchObject(input);
    expect(result.executeAt).toBe(input.executeAt);
    expect(result.sourceMessageAt).toBe(input.sourceMessageAt);
  });
});

describe('commercial durable deletion proof', () => {
  it('returns an inline duplicate decline without borrowing DELETE or event success', async () => {
    const legacy = jest.fn();
    const result = await executeDurableModerationDelete({
      input: { chatId: 'chat', messageId: 'message', reasonKey: 'duplicate' },
      service: {
        getRolloutForInput: () => 'execute',
        ensureAndAttempt: async () => ({
          kind: 'inline_declined',
          confirmed: false,
          intentId: 'intent',
          status: 'RETRYABLE',
        }),
      },
      legacy,
      logger: { warn: jest.fn() },
    });
    expect(result).toEqual({
      accepted: true,
      gone: false,
      deleted: false,
      eventPersistedByIntent: false,
      botId: null,
      inlineDeclined: true,
    });
    expect(legacy).not.toHaveBeenCalled();
  });
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
