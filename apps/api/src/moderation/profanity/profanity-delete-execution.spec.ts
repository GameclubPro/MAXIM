import {
  executeProfanityGuardedLegacyDelete,
  type ProfanityDeleteMutationHooks,
} from './profanity-delete-execution';
import { ProfanityDeleteGuardRejectedError } from './profanity-delete-guard.service';

const input = {
  chatId: 'chat-1',
  messageId: 'message-1',
  ruleCode: 'PROFANITY_DELETE',
  subjectUserId: 'user-1',
  event: { score: 0.95 },
};

function buildHarness() {
  const guard = { assertMessageStillActionable: jest.fn().mockResolvedValue('allowed') };
  const mutate = jest.fn().mockResolvedValue({ ok: true, botId: 'delete-bot' });
  const execute = jest.fn(async (hooks?: ProfanityDeleteMutationHooks) => {
    hooks?.beforeAttempt();
    await hooks?.beforeDeleteMutation('delete-bot');
    return mutate();
  });
  return { guard, mutate, execute };
}

describe('executeProfanityGuardedLegacyDelete', () => {
  it('confirms proof only after the guarded mutation succeeds', async () => {
    const harness = buildHarness();

    await expect(
      executeProfanityGuardedLegacyDelete({
        input,
        scheduled: false,
        guard: harness.guard,
        execute: harness.execute,
      }),
    ).resolves.toEqual({
      accepted: true,
      gone: true,
      deleted: true,
      eventPersistedByIntent: false,
      botId: 'delete-bot',
      profanityVerified: true,
    });

    expect(harness.guard.assertMessageStillActionable).toHaveBeenCalledWith({
      chatId: 'chat-1',
      messageId: 'message-1',
      subjectUserId: 'user-1',
      botId: 'delete-bot',
      minimumScore: 0.95,
    });
    expect(harness.guard.assertMessageStillActionable.mock.invocationCallOrder[0]).toBeLessThan(
      harness.mutate.mock.invocationCallOrder[0]!,
    );
  });

  it('preserves ordinary deletion without requiring or invoking a profanity guard', async () => {
    const harness = buildHarness();

    const result = await executeProfanityGuardedLegacyDelete({
      input: { ...input, ruleCode: 'LINK_BLOCKED_DELETE' },
      scheduled: false,
      execute: harness.execute,
    });

    expect(harness.execute).toHaveBeenCalledWith(undefined);
    expect(harness.guard.assertMessageStillActionable).not.toHaveBeenCalled();
    expect(result).toMatchObject({ accepted: true, deleted: true });
    expect(result).not.toHaveProperty('profanityVerified');
  });

  it('rejects missing guard wiring before invoking the executor', async () => {
    const harness = buildHarness();

    await expect(
      executeProfanityGuardedLegacyDelete({
        input,
        scheduled: false,
        execute: harness.execute,
      }),
    ).rejects.toThrow('Profanity delete guard is unavailable');
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it('keeps exact absence distinct from a verified deletion', async () => {
    const harness = buildHarness();
    harness.guard.assertMessageStillActionable.mockResolvedValue('absent');

    await expect(
      executeProfanityGuardedLegacyDelete({
        input,
        scheduled: false,
        guard: harness.guard,
        execute: harness.execute,
      }),
    ).resolves.toEqual({
      accepted: true,
      gone: true,
      deleted: false,
      eventPersistedByIntent: false,
      botId: null,
    });
    expect(harness.mutate).not.toHaveBeenCalled();
  });

  it('maps obsolete decisions to a rejected result without mutating', async () => {
    const harness = buildHarness();
    harness.guard.assertMessageStillActionable.mockRejectedValue(
      new ProfanityDeleteGuardRejectedError(
        'profanity_violation_no_longer_present',
        'Current text is clean',
      ),
    );

    await expect(
      executeProfanityGuardedLegacyDelete({
        input,
        scheduled: false,
        guard: harness.guard,
        execute: harness.execute,
      }),
    ).resolves.toEqual({
      accepted: false,
      gone: false,
      deleted: false,
      eventPersistedByIntent: false,
      botId: null,
    });
    expect(harness.mutate).not.toHaveBeenCalled();
  });

  it('propagates transient failures for retry without reporting verification', async () => {
    const harness = buildHarness();
    const failure = new Error('MAX unavailable');
    harness.guard.assertMessageStillActionable.mockRejectedValue(failure);

    await expect(
      executeProfanityGuardedLegacyDelete({
        input,
        scheduled: false,
        guard: harness.guard,
        execute: harness.execute,
      }),
    ).rejects.toBe(failure);
    expect(harness.mutate).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'unsuccessful', ok: false, scheduled: false },
    { label: 'scheduled', ok: true, scheduled: true },
  ])('does not verify an $label mutation result', async ({ ok, scheduled }) => {
    const harness = buildHarness();
    harness.mutate.mockResolvedValue({ ok, botId: 'delete-bot' });

    const result = await executeProfanityGuardedLegacyDelete({
      input,
      scheduled,
      guard: harness.guard,
      execute: harness.execute,
    });

    expect(result).toMatchObject({ accepted: ok, gone: false, deleted: false });
    expect(result).not.toHaveProperty('profanityVerified');
  });

  it.each([false, true])(
    'does not reuse earlier proof when a later attempt resets it: %s',
    async (earlierProof) => {
      const harness = buildHarness();
      harness.execute.mockImplementation(async (hooks) => {
        hooks?.beforeAttempt();
        if (earlierProof) await hooks?.beforeDeleteMutation('first-bot');
        hooks?.beforeAttempt();
        return { ok: true, botId: 'cached-result-bot' };
      });

      const result = await executeProfanityGuardedLegacyDelete({
        input,
        scheduled: false,
        guard: harness.guard,
        execute: harness.execute,
      });

      expect(result).toMatchObject({ accepted: true, deleted: true });
      expect(result).not.toHaveProperty('profanityVerified');
    },
  );
});
