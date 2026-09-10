import { MessageDuplicateEnforcementService } from './message-duplicate-enforcement.service';
import { MessageDuplicateHistoryService } from './message-duplicate-history.service';
import { extractDuplicateMessageContent } from './message-duplicate-content';
import { duplicateSettings } from './message-duplicate-test-fixtures';
import { buildMessageScopedModerationActionClaimKey } from '../moderation-message-action-claim';
import { ModerationDeleteIntentService } from '../moderation-delete-intent.service';
import type { EnsureModerationDeleteIntentInput } from '../moderation-delete-intent.types';
import type { ModerationMessageActionClaimData } from '../moderation-message-action-claim';

describe('message duplicate delete-only action claims', () => {
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
      resolve: jest
        .fn()
        .mockResolvedValue({
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
