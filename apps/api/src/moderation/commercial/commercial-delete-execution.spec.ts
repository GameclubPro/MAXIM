import { executeCommercialGuardedLegacyDelete } from './commercial-delete-execution';
import { CommercialDeleteGuardRejectedError } from './commercial-delete-guard.service';

const input = {
  chatId: 'chat',
  messageId: 'message',
  subjectUserId: 'user',
  reasonKey: 'reason',
  ruleCode: 'COMMERCIAL_AD_DELETE',
};
const deleted = {
  accepted: true,
  gone: true,
  deleted: true,
  eventPersistedByIntent: false,
  botId: 'bot',
};
describe('commercial guarded legacy deletion', () => {
  it('requires proof from this transport attempt', async () => {
    const guard = { assertMessageStillActionable: jest.fn().mockResolvedValue('allowed') };
    const result = await executeCommercialGuardedLegacyDelete({
      input,
      guard,
      execute: async (hooks) => {
        hooks!.beforeAttempt();
        await hooks!.beforeDeleteMutation('bot');
        return deleted;
      },
    });
    expect(result.commercialVerified).toBe(true);
    expect(guard.assertMessageStillActionable).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'bot',
        evidence: [{ reasonKey: 'reason', score: 0, metadata: undefined }],
      }),
    );
  });

  it.each(['absent', 'rejected', 'retry-unverified', 'scheduled'])(
    'does not invent sanction proof: %s',
    async (kind) => {
      const guard = {
        assertMessageStillActionable: jest
          .fn()
          .mockResolvedValue(kind === 'absent' ? 'absent' : 'allowed'),
      };
      if (kind === 'rejected')
        guard.assertMessageStillActionable.mockRejectedValue(
          new CommercialDeleteGuardRejectedError('commercial_text_settings_disabled'),
        );
      const result = await executeCommercialGuardedLegacyDelete({
        input,
        guard,
        execute: async (hooks) => {
          hooks!.beforeAttempt();
          await hooks!.beforeDeleteMutation('bot');
          if (kind === 'retry-unverified') hooks!.beforeAttempt();
          return kind === 'scheduled' ? { ...deleted, deleted: false, gone: false } : deleted;
        },
      });
      expect(result.commercialVerified).toBeUndefined();
    },
  );

  it('does not silently bypass a missing guard', async () => {
    const execute = jest.fn().mockResolvedValue(deleted);
    await expect(executeCommercialGuardedLegacyDelete({ input, execute })).rejects.toThrow(
      'guard is unavailable',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses to serialize a guard into delayed legacy work', async () => {
    const execute = jest.fn().mockResolvedValue(deleted);
    await expect(
      executeCommercialGuardedLegacyDelete({
        input: { ...input, executeAt: new Date(Date.now() + 60_000) },
        guard: { assertMessageStillActionable: jest.fn() },
        execute,
      }),
    ).rejects.toThrow('durable guarded executor');
    expect(execute).not.toHaveBeenCalled();
  });
});
