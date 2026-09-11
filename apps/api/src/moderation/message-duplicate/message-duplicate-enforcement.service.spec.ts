import { MessageDuplicateEnforcementService } from './message-duplicate-enforcement.service';
import { MessageDuplicateHistoryService } from './message-duplicate-history.service';
import { extractDuplicateMessageContent } from './message-duplicate-content';
import { duplicateSettings, duplicateUpdate } from './message-duplicate-test-fixtures';
import { MessageDuplicateGuardRejectedError } from './message-duplicate-delete-guard.service';
import { buildMessageScopedModerationActionClaimKey } from '../moderation-message-action-claim';
import { ModerationDeleteIntentService } from '../moderation-delete-intent.service';
import type { EnsureModerationDeleteIntentInput } from '../moderation-delete-intent.types';
import type { ModerationMessageActionClaimData } from '../moderation-message-action-claim';

describe('message duplicate delete-only action claims', () => {
  it.each(
    [
      [1, null],
      [2, 'WARN'],
      [3, 'MUTE'],
      [4, 'BAN'],
    ].flatMap(([repeatCount, expected]) =>
      ['text', 'photo'].map((kind) => ({ repeatCount: repeatCount as number, expected, kind })),
    ),
  )(
    'uses the configured full reaction ladder at repeat $repeatCount for $kind',
    async ({ repeatCount, expected, kind }) => {
      const settings = duplicateSettings({
        duplicateBotMessageEnabled: true,
        duplicateWarnEnabled: true,
        duplicateMuteEnabled: true,
        duplicateBanEnabled: true,
        duplicateWarnMaxCount: 2,
        duplicateMuteMaxCount: 3,
        duplicateBanMaxCount: 4,
        duplicateMuteDurationHours: 12,
      });
      const update = duplicateUpdate(
        'm2',
        Date.now() - 1000,
        kind === 'photo' ? '' : 'a',
        kind === 'photo'
          ? [{ type: 'image', payload: { photo_id: 'photo', url: 'https://i.oneme.ru/photo' } }]
          : [],
      );
      const history = new MessageDuplicateHistoryService({
        replaceRevisionedSetMembershipsBeforeDeadline: jest
          .fn()
          .mockResolvedValue({ kind: 'applied', counts: [repeatCount + 1] }),
      } as never);
      const result = await history.observe({
        chatId: '-123',
        userId: '123',
        messageId: 'm2',
        eventTimestampMs: Date.parse(update.message!.createdAt),
        controlRevision: 2,
        settings,
        content: extractDuplicateMessageContent(update.raw),
        mediaHashes: kind === 'photo' ? ['a'.repeat(64)] : [],
      });
      const intents = {
        ensureIntentWithMessageActionClaim: jest.fn().mockResolvedValue({
          claim: 'claimed',
          intent: { intentId: 'intent', rollout: 'execute' },
        }),
      };
      const policy = {
        resolve: jest.fn().mockResolvedValue({
          mode: 'full',
          revision: 2,
          effectiveAtMs: Date.now() - 10000,
          expiresAtMs: Number.MAX_SAFE_INTEGER,
        }),
      };
      const guard = { assertMessageStillActionable: jest.fn().mockResolvedValue('allowed') };
      const executeFullAction = jest.fn();
      const service = new MessageDuplicateEnforcementService(
        intents as never,
        policy as never,
        {} as never,
        guard as never,
      );
      await service.enqueue({
        ...result!,
        settings,
        chatId: '-123',
        botId: 'bot',
        update,
        sourceCreatedAt: update.message!.createdAt,
        text: 'a',
        executeFullAction,
      });
      const request = executeFullAction.mock.calls[0]![0];
      expect(request.settings.duplicateMuteDurationHours).toBe(12);
      expect(request.outcome.kind).toBe(expected ? 'decision' : 'hit');
      expect(request.outcome.decision?.action ?? null).toBe(expected);
      expect(request.deleteIntent).toBe(
        intents.ensureIntentWithMessageActionClaim.mock.calls[0]![0].intent,
      );
      expect(request.deleteIntent.event.metadata.messageDuplicate.version).toBe(2);
      expect(request.deleteIntent.event.metadata.messageDuplicate.hasPhotos).toBe(kind === 'photo');
      expect(request.deleteIntent.event.metadata.enforcementScope).toBe('full');
      if (expected) {
        expect(request.deleteIntent.event.metadata.messageDuplicate.requiredCount).toBe(
          repeatCount + 1,
        );
        await expect(request.authorizeSanction()).resolves.toBe(true);
        expect(guard.assertMessageStillActionable).toHaveBeenLastCalledWith(
          expect.objectContaining({ sanctionIntentId: 'intent' }),
        );
        guard.assertMessageStillActionable.mockRejectedValue(
          new MessageDuplicateGuardRejectedError('revoked'),
        );
        await expect(request.authorizeSanction()).resolves.toBe(false);
        await expect(request.beforeSanctionMutation()).rejects.toThrow('sanction_revoked');
      }
      intents.ensureIntentWithMessageActionClaim.mockResolvedValue({
        claim: 'blocked',
        intent: null,
      });
      executeFullAction.mockClear();
      await service.enqueue({
        ...result!,
        settings,
        chatId: '-123',
        botId: 'bot',
        update,
        sourceCreatedAt: update.message!.createdAt,
        text: 'a',
        executeFullAction,
      });
      expect(executeFullAction).not.toHaveBeenCalled();
    },
  );
  it('uses the shared whole-message claim, validates the binding and keeps one action across edits', async () => {
    const settings = duplicateSettings({
      duplicateMuteEnabled: true,
      duplicateBanEnabled: true,
      duplicateMuteMaxCount: 1,
    });
    const history = new MessageDuplicateHistoryService({
      replaceRevisionedSetMembershipsBeforeDeadline: jest
        .fn()
        .mockResolvedValue({ kind: 'applied', counts: [21] }),
    } as never);
    const result = await history.observe({
      chatId: '-123',
      userId: '123',
      messageId: 'm',
      eventTimestampMs: Date.now() - 1000,
      controlRevision: 1,
      settings,
      content: extractDuplicateMessageContent({ message: { body: { text: 'a' } } }),
    });
    expect(result).not.toBeNull();
    const actualGuard = Object.create(ModerationDeleteIntentService.prototype) as {
      assertClaimMatchesIntent: (
        claim: ModerationMessageActionClaimData,
        intent: EnsureModerationDeleteIntentInput,
      ) => void;
    };
    const intents = {
      ensureIntentWithMessageActionClaim: jest.fn(
        async (input: {
          claim: ModerationMessageActionClaimData;
          intent: EnsureModerationDeleteIntentInput;
        }) => {
          actualGuard.assertClaimMatchesIntent(input.claim, input.intent);
          return { claim: 'claimed' };
        },
      ),
    };
    const policy = {
      resolve: jest.fn().mockResolvedValue({
        mode: 'delete_only',
        revision: 1,
        effectiveAtMs: Date.now() - 10000,
        expiresAtMs: Date.now() + 3600000,
      }),
    };
    const photos = { resolveEffectivePolicy: jest.fn().mockResolvedValue({ enforce: false }) };
    const enforcement = new MessageDuplicateEnforcementService(
      intents as never,
      policy as never,
      photos as never,
      {} as never,
    );
    const params = {
      ...result!,
      settings,
      chatId: '-123',
      botId: 'bot',
      sourceCreatedAt: new Date().toISOString(),
      text: 'a',
    };
    expect(await enforcement.enqueue(params)).toBe(true);
    expect(
      await enforcement.enqueue({
        ...params,
        binding: { ...params.binding, eventTimestampMs: Date.now() },
      }),
    ).toBe(true);
    const [first, second] = intents.ensureIntentWithMessageActionClaim.mock.calls.map(
      (call) => call[0],
    );
    expect(first!.claim.dedupeKey).toBe(second!.claim.dedupeKey);
    expect(first!.claim.messageActionKey).toBe(
      buildMessageScopedModerationActionClaimKey('-123', 'm'),
    );
    expect(first!.intent.ruleCode).toBe('DUPLICATE_DELETE');
    expect(first!.intent.event?.metadata).toMatchObject({
      enforcementScope: 'delete_only',
      duplicateSource: 'message_v1',
    });
    expect(() =>
      actualGuard.assertClaimMatchesIntent({ ...first!.claim, messageId: 'other' }, first!.intent),
    ).toThrow('does not match');
    expect(
      await enforcement.enqueue({ ...params, binding: { ...params.binding, hasPhotos: true } }),
    ).toBe(false);
    policy.resolve.mockResolvedValue({ mode: 'off' });
    expect(await enforcement.enqueue(params)).toBe(false);
    expect(intents.ensureIntentWithMessageActionClaim).toHaveBeenCalledTimes(2);
  });
});
