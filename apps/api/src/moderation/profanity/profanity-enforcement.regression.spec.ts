import {
  ModerationService,
  SanctionAction,
  createSettings,
  createUpdate,
} from '../moderation.service.spec-support';
import { ProfanityDeleteGuardRejectedError } from './profanity-delete-guard.service';

function buildHarness() {
  const prisma = {
    chat: {
      upsert: jest.fn().mockResolvedValue({
        id: 'chat-1',
        title: 'Chat 1',
        domains: [],
        settings: createSettings({
          profanityBotMessageEnabled: true,
          profanityWarnEnabled: true,
          profanityMuteEnabled: true,
          profanityBanEnabled: true,
        }),
      }),
    },
    violation: { create: jest.fn(), count: jest.fn().mockResolvedValue(2) },
    moderationEvent: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
    webhookEvent: { findUnique: jest.fn(), update: jest.fn() },
  };
  const ruleEngine = {
    detect: jest.fn().mockResolvedValue({
      violations: [{ ruleCode: 'PROFANITY', score: 0.95, reason: 'Detected profanity' }],
    }),
  };
  const remoteDelete = jest.fn();
  const maxClient = {
    deleteMessage: jest.fn(
      async (
        _chatId: string,
        _messageId: string,
        options?: { beforeImmediateDeleteMutation?: () => Promise<void> },
      ) => {
        await options?.beforeImmediateDeleteMutation?.();
        remoteDelete();
      },
    ),
    sendMessage: jest.fn(),
    kickMember: jest.fn(),
    banMember: jest.fn(),
    notifyModerators: jest.fn(),
  };
  const guard = { assertMessageStillActionable: jest.fn().mockResolvedValue('allowed') };
  const service = new ModerationService(
    prisma as never,
    ruleEngine as never,
    { resolveAction: jest.fn() } as never,
    maxClient as never,
  );
  Object.assign(service, { profanityDeleteGuard: guard });
  return { service, prisma, ruleEngine, maxClient, guard, remoteDelete };
}

describe('profanity enforcement dispatch safety', () => {
  it.each(['off', 'observed'] as const)(
    'stops legacy %s deletion and follow-up sanctions when current text is clean',
    async (kind) => {
      const harness = buildHarness();
      Object.assign(harness.service, {
        moderationDeleteIntentService: {
          ensureIntent: jest.fn(),
          ensureAndAttempt: jest.fn().mockResolvedValue({ kind, confirmed: false }),
          getRolloutForInput: jest.fn().mockReturnValue(kind === 'off' ? 'off' : 'observed'),
        },
      });
      harness.guard.assertMessageStillActionable.mockRejectedValue(
        new ProfanityDeleteGuardRejectedError(
          'profanity_violation_no_longer_present',
          'Current message is clean',
        ),
      );

      await harness.service.handleUpdate(createUpdate());

      expect(harness.guard.assertMessageStillActionable).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: 'chat-1', messageId: 'msg-1', subjectUserId: 'user-1' }),
      );
      expect(harness.remoteDelete).not.toHaveBeenCalled();
      expect(harness.prisma.violation.create).not.toHaveBeenCalled();
      expect(harness.prisma.violation.count).not.toHaveBeenCalled();
      expect(harness.maxClient.sendMessage).not.toHaveBeenCalled();
      expect(harness.maxClient.banMember).not.toHaveBeenCalled();
      expect(harness.prisma.moderationEvent.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: 'rejected', kind: 'terminal', confirmed: false },
    { label: 'queued', kind: 'pending', confirmed: false },
    { label: 'waiting capability', kind: 'waiting_capability', confirmed: false },
    { label: 'ambiguous', kind: 'ambiguous', confirmed: false },
    { label: 'already absent', kind: 'already_absent', confirmed: true },
    { label: 'mixed independent reason', kind: 'confirmed', confirmed: true },
  ])(
    'does not record or escalate a $label outcome without a verified profanity DELETE',
    async ({ kind, confirmed }) => {
      const harness = buildHarness();
      Object.assign(harness.service, {
        moderationDeleteIntentService: {
          ensureIntent: jest.fn(),
          ensureAndAttempt: jest.fn().mockResolvedValue({ kind, confirmed }),
          getRolloutForInput: jest.fn().mockReturnValue('execute'),
        },
      });

      await harness.service.handleUpdate(createUpdate());

      expect(harness.remoteDelete).not.toHaveBeenCalled();
      expect(harness.prisma.violation.create).not.toHaveBeenCalled();
      expect(harness.prisma.violation.count).not.toHaveBeenCalled();
      expect(harness.maxClient.sendMessage).not.toHaveBeenCalled();
      expect(harness.maxClient.banMember).not.toHaveBeenCalled();
      expect(harness.prisma.moderationEvent.create).not.toHaveBeenCalled();
    },
  );

  it('keeps an unavailable fresh-text lookup retryable without follow-up sanctions', async () => {
    const harness = buildHarness();
    harness.guard.assertMessageStillActionable.mockRejectedValue(
      new Error('MAX lookup unavailable'),
    );

    await expect(harness.service.handleUpdate(createUpdate())).rejects.toThrow(
      'MAX lookup unavailable',
    );

    expect(harness.remoteDelete).not.toHaveBeenCalled();
    expect(harness.prisma.violation.create).not.toHaveBeenCalled();
    expect(harness.prisma.violation.count).not.toHaveBeenCalled();
    expect(harness.maxClient.sendMessage).not.toHaveBeenCalled();
    expect(harness.maxClient.banMember).not.toHaveBeenCalled();
  });

  it('does not fall back to an unguarded DELETE when the profanity guard is missing', async () => {
    const harness = buildHarness();
    Object.assign(harness.service, { profanityDeleteGuard: undefined });

    await expect(harness.service.handleUpdate(createUpdate())).rejects.toThrow(
      'Profanity delete guard is unavailable',
    );

    expect(harness.maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(harness.prisma.violation.create).not.toHaveBeenCalled();
    expect(harness.prisma.violation.count).not.toHaveBeenCalled();
    expect(harness.maxClient.sendMessage).not.toHaveBeenCalled();
    expect(harness.maxClient.banMember).not.toHaveBeenCalled();
  });

  it('does not record or sanction a legacy exact-absence result', async () => {
    const harness = buildHarness();
    harness.guard.assertMessageStillActionable.mockResolvedValue('absent');

    await harness.service.handleUpdate(createUpdate());

    expect(harness.remoteDelete).not.toHaveBeenCalled();
    expect(harness.prisma.violation.create).not.toHaveBeenCalled();
    expect(harness.prisma.violation.count).not.toHaveBeenCalled();
    expect(harness.maxClient.sendMessage).not.toHaveBeenCalled();
    expect(harness.maxClient.banMember).not.toHaveBeenCalled();
  });

  it('does not carry verification from a failed route into an unverified fallback result', async () => {
    const harness = buildHarness();
    harness.maxClient.deleteMessage
      .mockImplementationOnce(async (_chatId, _messageId, options) => {
        await options?.beforeImmediateDeleteMutation?.();
        throw new Error('First route rejected DELETE');
      })
      .mockResolvedValueOnce(undefined);
    Object.assign(harness.service, {
      executeModerationActionWithFallbackResult: async (params: {
        operation: (botId: string) => Promise<void>;
      }) => {
        await params.operation('first-bot').catch(() => undefined);
        await params.operation('fallback-bot');
        return { ok: true, botId: 'fallback-bot' };
      },
    });

    await harness.service.handleUpdate(createUpdate());

    expect(harness.guard.assertMessageStillActionable).toHaveBeenCalledTimes(1);
    expect(harness.prisma.violation.create).not.toHaveBeenCalled();
    expect(harness.prisma.violation.count).not.toHaveBeenCalled();
    expect(harness.maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('preserves the configured warning after a verified current violation is deleted', async () => {
    const harness = buildHarness();

    await harness.service.handleUpdate(createUpdate());

    expect(harness.guard.assertMessageStillActionable).toHaveBeenCalledTimes(1);
    expect(harness.remoteDelete).toHaveBeenCalledTimes(1);
    expect(harness.prisma.violation.create).toHaveBeenCalledTimes(1);
    expect(harness.remoteDelete.mock.invocationCallOrder[0]).toBeLessThan(
      harness.prisma.violation.create.mock.invocationCallOrder[0]!,
    );
    expect(harness.prisma.violation.count).toHaveBeenCalledTimes(1);
    expect(harness.maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ ruleCode: 'PROFANITY', action: SanctionAction.WARN }),
    });
  });

  it('records one violation after a freshly verified durable DELETE and retains escalation', async () => {
    const harness = buildHarness();
    const ensureAndAttempt = jest.fn().mockResolvedValue({
      kind: 'confirmed',
      confirmed: true,
      botId: 'delete-bot',
      profanityVerified: true,
    });
    Object.assign(harness.service, {
      moderationDeleteIntentService: {
        ensureIntent: jest.fn(),
        ensureAndAttempt,
        getRolloutForInput: jest.fn().mockReturnValue('execute'),
      },
    });

    await harness.service.handleUpdate(createUpdate());

    expect(harness.prisma.violation.create).toHaveBeenCalledTimes(1);
    expect(ensureAndAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      harness.prisma.violation.create.mock.invocationCallOrder[0]!,
    );
    expect(harness.prisma.violation.count).toHaveBeenCalledTimes(1);
    expect(harness.maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ ruleCode: 'PROFANITY', action: SanctionAction.WARN }),
    });
  });

  it('does not count a cancelled decision toward the next verified violation', async () => {
    const harness = buildHarness();
    harness.prisma.violation.count.mockImplementation(
      async () => harness.prisma.violation.create.mock.calls.length,
    );
    harness.guard.assertMessageStillActionable.mockRejectedValueOnce(
      new ProfanityDeleteGuardRejectedError(
        'profanity_violation_no_longer_present',
        'Current text is clean',
      ),
    );
    await harness.service.handleUpdate(createUpdate());
    expect(harness.prisma.violation.create).not.toHaveBeenCalled();

    const next = createUpdate();
    next.message!.messageId = 'next-message';
    await harness.service.handleUpdate(next);

    expect(harness.prisma.violation.create).toHaveBeenCalledTimes(1);
    expect(harness.prisma.moderationEvent.create).not.toHaveBeenCalledWith({
      data: expect.objectContaining({ ruleCode: 'PROFANITY', action: SanctionAction.WARN }),
    });
    expect(harness.maxClient.banMember).not.toHaveBeenCalled();
  });

  it('leaves unrelated deletion and follow-up semantics unchanged', async () => {
    const harness = buildHarness();
    harness.ruleEngine.detect.mockResolvedValue({
      violations: [{ ruleCode: 'MESSAGE_BLOCKED_WORD', score: 0.95, reason: 'Blocked word' }],
    });

    await harness.service.handleUpdate(createUpdate());

    expect(harness.guard.assertMessageStillActionable).not.toHaveBeenCalled();
    expect(harness.remoteDelete).toHaveBeenCalledTimes(1);
    expect(harness.prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ ruleCode: 'MESSAGE_BLOCKED_WORD_DELETE' }),
    });
  });
});
