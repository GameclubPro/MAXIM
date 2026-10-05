import { MessageDuplicateEnforcementService } from './message-duplicate-enforcement.service';
import { MessageDuplicateHistoryService } from './message-duplicate-history.service';
import { extractDuplicateMessageContent } from './message-duplicate-content';
import { duplicateSettings, duplicateUpdate } from './message-duplicate-test-fixtures';
import { MessageDuplicateGuardRejectedError } from './message-duplicate-delete-guard.service';
import { buildMessageScopedModerationActionClaimKey } from '../moderation-message-action-claim';
import { ModerationDeleteIntentService } from '../moderation-delete-intent.service';
import type { EnsureModerationDeleteIntentInput } from '../moderation-delete-intent.types';
import { digestDuplicateContent } from './message-duplicate-content';
import type { ModerationMessageActionClaimData } from '../moderation-message-action-claim';

function windowResult(repeatCount: number) {
  return jest.fn(
    async (
      _chatId: string,
      input: {
        fingerprints: string[];
        author: string;
        senderId: string;
        at: number;
        windowMs: number;
        source: string;
        identity: string;
        mediaHashes: string[];
      },
    ) => ({
      kind: 'ok',
      revision: digestDuplicateContent('duplicate revision'),
      matches: [
        {
          fingerprint: input.fingerprints[0],
          count: repeatCount,
          original: {
            member: digestDuplicateContent('original'),
            author: input.author,
            messageId: 'original',
            senderId: input.senderId,
            publishedAtMs: input.at - 1000,
            observedAtMs: input.at - 1000,
            expiresAtMs: input.at + input.windowMs - 1000,
            sourceDigest: input.source,
            contentDigest: input.identity,
            mediaHashes: input.mediaHashes,
            epoch: 0,
            revision: digestDuplicateContent('original revision'),
            originalId: digestDuplicateContent('stable original identity'),
          },
        },
      ],
    }),
  );
}

async function enforcementCase() {
  const settings = duplicateSettings({ duplicateWarnEnabled: true, duplicateWarnMaxCount: 1 });
  const update = duplicateUpdate('repeat', Date.now() - 1000, 'offer');
  const history = new MessageDuplicateHistoryService({ duplicateWindow: windowResult(2) } as never);
  const result = await history.observe({
    chatId: '-123',
    userId: '123',
    messageId: 'repeat',
    eventTimestampMs: Date.parse(update.message!.createdAt),
    controlRevision: 1,
    settings,
    content: extractDuplicateMessageContent(update.raw),
  });
  result!.binding.authorization = {
    eventTimestampMs: Date.parse(update.message!.createdAt),
    deadlineAtMs: Date.parse(update.message!.createdAt) + 600_000,
  };
  const intents = {
    claimMessageActionBeforeQualification: jest.fn().mockResolvedValue('claimed'),
    releaseUnmaterializedMessageAction: jest.fn().mockResolvedValue(true),
    ensureIntentWithMessageActionClaim: jest
      .fn()
      .mockResolvedValue({ claim: 'resumed', intent: { intentId: 'intent', rollout: 'execute' } }),
  };
  const policy = {
    resolve: jest.fn().mockResolvedValue({
      mode: 'full',
      revision: 1,
      effectiveAtMs: Date.now() - 10_000,
      expiresAtMs: Number.MAX_SAFE_INTEGER,
    }),
  };
  const guard = {
    assertQualificationAuthority: jest.fn().mockResolvedValue(undefined),
    qualify: jest.fn().mockResolvedValue(2),
    assertMessageStillActionable: jest.fn().mockResolvedValue('allowed'),
  };
  const service = new MessageDuplicateEnforcementService(
    intents as never,
    policy as never,
    guard as never,
  );
  const executeFullAction = jest.fn();
  const params = {
    ...result!,
    settings,
    chatId: '-123',
    botId: 'bot',
    update,
    sourceCreatedAt: update.message!.createdAt,
    text: 'offer',
    executeFullAction,
  };
  return { intents, policy, guard, service, params, executeFullAction };
}

describe('message duplicate delete-only action claims', () => {
  it('releases an interrupted unused owner when runtime policy rejects the retry', async () => {
    const s = await enforcementCase();
    s.policy.resolve.mockResolvedValue({ mode: 'off' });
    expect(await s.service.enqueue(s.params)).toEqual({
      kind: 'rejected',
      reason: 'policy_changed',
    });
    expect(s.intents.releaseUnmaterializedMessageAction).toHaveBeenCalledTimes(1);
    expect(s.intents.claimMessageActionBeforeQualification).not.toHaveBeenCalled();
    expect(s.guard.qualify).not.toHaveBeenCalled();
    expect(s.intents.ensureIntentWithMessageActionClaim).not.toHaveBeenCalled();
  });

  it('does not reserve the whole-message claim after authorization is revoked', async () => {
    const s = await enforcementCase();
    s.guard.assertQualificationAuthority.mockRejectedValue(
      new MessageDuplicateGuardRejectedError('revoked'),
    );
    expect(await s.service.enqueue(s.params)).toEqual({
      kind: 'rejected',
      reason: 'qualification_rejected',
    });
    expect(s.intents.claimMessageActionBeforeQualification).not.toHaveBeenCalled();
    expect(s.guard.qualify).not.toHaveBeenCalled();
    expect(s.intents.releaseUnmaterializedMessageAction).toHaveBeenCalledTimes(1);
  });
  it('releases an interrupted unused claim when a retry loses authority before qualification', async () => {
    const s = await enforcementCase();
    s.guard.qualify.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(s.service.enqueue(s.params)).rejects.toThrow('redis unavailable');
    expect(s.intents.releaseUnmaterializedMessageAction).not.toHaveBeenCalled();
    s.guard.assertQualificationAuthority.mockRejectedValueOnce(
      new MessageDuplicateGuardRejectedError('revoked'),
    );
    expect(await s.service.enqueue(s.params)).toEqual({
      kind: 'rejected',
      reason: 'qualification_rejected',
    });
    expect(s.intents.claimMessageActionBeforeQualification).toHaveBeenCalledTimes(1);
    expect(s.guard.qualify).toHaveBeenCalledTimes(1);
    expect(s.intents.releaseUnmaterializedMessageAction).toHaveBeenCalledTimes(1);
    expect(s.intents.ensureIntentWithMessageActionClaim).not.toHaveBeenCalled();
  });
  it('does not qualify an event whose whole-message claim belongs to another rule', async () => {
    const s = await enforcementCase();
    s.intents.claimMessageActionBeforeQualification.mockResolvedValue('blocked');
    expect(await s.service.enqueue(s.params)).toEqual({
      kind: 'rejected',
      reason: 'claim_blocked',
    });
    expect(s.guard.qualify).not.toHaveBeenCalled();
    expect(s.intents.ensureIntentWithMessageActionClaim).not.toHaveBeenCalled();
    expect(s.executeFullAction).not.toHaveBeenCalled();
    expect(s.intents.releaseUnmaterializedMessageAction).not.toHaveBeenCalled();
  });

  it.each(['no_match', 'revoked'] as const)(
    'releases its unused claim after qualification is %s',
    async (outcome) => {
      const s = await enforcementCase();
      if (outcome === 'no_match') s.guard.qualify.mockResolvedValue(null);
      else s.guard.qualify.mockRejectedValue(new MessageDuplicateGuardRejectedError('revoked'));
      expect(await s.service.enqueue(s.params)).toEqual({
        kind: 'rejected',
        reason: 'qualification_rejected',
      });
      expect(s.intents.releaseUnmaterializedMessageAction).toHaveBeenCalledWith({
        claim: expect.objectContaining({
          messageActionKey: buildMessageScopedModerationActionClaimKey('-123', 'repeat'),
          ruleCode: 'DUPLICATE_MESSAGE_ACTION',
        }),
        binding: expect.objectContaining({
          messageId: 'repeat',
          authorization: s.params.binding.authorization,
        }),
      });
      expect(s.intents.ensureIntentWithMessageActionClaim).not.toHaveBeenCalled();
    },
  );

  it('releases its unused claim when authority changes after reserving the stage', async () => {
    const s = await enforcementCase();
    s.guard.assertQualificationAuthority
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new MessageDuplicateGuardRejectedError('revoked'));
    expect(await s.service.enqueue(s.params)).toEqual({
      kind: 'rejected',
      reason: 'qualification_rejected',
    });
    expect(s.guard.qualify).toHaveBeenCalledTimes(1);
    expect(s.intents.releaseUnmaterializedMessageAction).toHaveBeenCalledTimes(1);
    expect(s.intents.ensureIntentWithMessageActionClaim).not.toHaveBeenCalled();
  });

  it('keeps an unused claim resumable when qualification infrastructure is temporarily unavailable', async () => {
    const s = await enforcementCase();
    s.guard.qualify.mockRejectedValue(new Error('redis unavailable'));
    await expect(s.service.enqueue(s.params)).rejects.toThrow('redis unavailable');
    expect(s.intents.releaseUnmaterializedMessageAction).not.toHaveBeenCalled();
    expect(s.intents.ensureIntentWithMessageActionClaim).not.toHaveBeenCalled();
  });

  it('resumes its existing claim before retrying qualification and intent persistence', async () => {
    const s = await enforcementCase();
    s.intents.ensureIntentWithMessageActionClaim.mockRejectedValueOnce(
      new Error('lost persistence response'),
    );
    await expect(s.service.enqueue(s.params)).rejects.toThrow('lost persistence response');
    expect(s.intents.releaseUnmaterializedMessageAction).not.toHaveBeenCalled();
    s.intents.claimMessageActionBeforeQualification.mockResolvedValue('resumed');
    await s.service.enqueue(s.params);
    expect(
      s.intents.claimMessageActionBeforeQualification.mock.invocationCallOrder[0],
    ).toBeLessThan(s.guard.qualify.mock.invocationCallOrder[0]!);
    expect(
      s.intents.claimMessageActionBeforeQualification.mock.invocationCallOrder[1],
    ).toBeLessThan(s.guard.qualify.mock.invocationCallOrder[1]!);
    expect(
      s.intents.ensureIntentWithMessageActionClaim.mock.calls[0]![0].intent.event.metadata.count,
    ).toBe(
      s.intents.ensureIntentWithMessageActionClaim.mock.calls[1]![0].intent.event.metadata.count,
    );
    expect(s.executeFullAction).toHaveBeenCalledTimes(1);
    expect(s.intents.releaseUnmaterializedMessageAction).not.toHaveBeenCalled();
  });

  it('rechecks a late revocation in the final delete and sanction callbacks', async () => {
    const s = await enforcementCase();
    await s.service.enqueue(s.params);
    const request = s.executeFullAction.mock.calls[0]![0];
    s.guard.assertMessageStillActionable.mockRejectedValue(
      new MessageDuplicateGuardRejectedError('revoked'),
    );
    expect(await request.authorizeDelete()).toBe(false);
    expect(await request.authorizeSanction()).toBe(false);
    await expect(request.beforeSanctionMutation()).rejects.toThrow('sanction_revoked');
    expect(s.intents.releaseUnmaterializedMessageAction).not.toHaveBeenCalled();
  });

  it('reads the surviving member executor lazily and places route checks inside final authority', async () => {
    const s = await enforcementCase();
    let selected = 'original';
    await s.service.enqueue({ ...s.params, readSelectedBotId: () => selected });
    const request = s.executeFullAction.mock.calls[0]![0];
    selected = 'surviving-peer';
    const route = jest.fn(async () => undefined);
    await request.beforeSanctionMutation(route);
    const finalInput = s.guard.assertMessageStillActionable.mock.calls.at(-1)![0];
    expect(finalInput.botId).toBe('surviving-peer');
    expect(finalInput.sanctionIntentId).toBe('intent');
    expect(route).not.toHaveBeenCalled();
    await finalInput.beforeFinalAuthority();
    expect(route).toHaveBeenCalledTimes(1);
    await request.authorizeSanction();
    expect(s.guard.assertMessageStillActionable.mock.calls.at(-1)![0].botId).toBe('bot');
  });

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
        duplicatePhotoEnabled: true,
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
        duplicateWindow: windowResult(repeatCount),
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
        ...(kind === 'photo' ? { imageScope: 'SAME_AUTHOR' as const } : {}),
      });
      result!.binding.authorization = {
        eventTimestampMs: Date.parse(update.message!.createdAt),
        deadlineAtMs: Date.parse(update.message!.createdAt) + 600_000,
      };
      const intents = {
        claimMessageActionBeforeQualification: jest.fn().mockResolvedValue('claimed'),
        releaseUnmaterializedMessageAction: jest.fn().mockResolvedValue(true),
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
      const guard = {
        assertQualificationAuthority: jest.fn().mockResolvedValue(undefined),
        qualify: jest.fn().mockResolvedValue(repeatCount),
        assertMessageStillActionable: jest.fn().mockResolvedValue('allowed'),
      };
      const executeFullAction = jest.fn();
      const service = new MessageDuplicateEnforcementService(
        intents as never,
        policy as never,
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
      expect(request.deleteIntent.event.metadata.messageDuplicate.version).toBe(3);
      expect(request.deleteIntent.event.metadata.messageDuplicate.hasPhotos).toBe(kind === 'photo');
      expect(request.deleteIntent.event.metadata.enforcementScope).toBe('full');
      if (expected) {
        expect(request.deleteIntent.event.metadata.messageDuplicate.requiredCount).toBe(2);
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
      duplicateWindow: windowResult(20),
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
    result!.binding.authorization = {
      eventTimestampMs: result!.binding.eventTimestampMs,
      deadlineAtMs: result!.binding.eventTimestampMs + 600_000,
    };
    const actualGuard = Object.create(ModerationDeleteIntentService.prototype) as {
      assertClaimMatchesIntent: (
        claim: ModerationMessageActionClaimData,
        intent: EnsureModerationDeleteIntentInput,
      ) => void;
    };
    const intents = {
      claimMessageActionBeforeQualification: jest.fn().mockResolvedValue('claimed'),
      releaseUnmaterializedMessageAction: jest.fn().mockResolvedValue(true),
      ensureIntentWithMessageActionClaim: jest.fn(
        async (input: {
          claim: ModerationMessageActionClaimData;
          intent: EnsureModerationDeleteIntentInput;
        }) => {
          actualGuard.assertClaimMatchesIntent(input.claim, input.intent);
          return { claim: 'claimed', intent: { intentId: 'intent', rollout: 'execute' } };
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
    const enforcement = new MessageDuplicateEnforcementService(
      intents as never,
      policy as never,
      {
        assertQualificationAuthority: jest.fn().mockResolvedValue(undefined),
        qualify: jest.fn().mockResolvedValue(20),
      } as never,
    );
    const params = {
      ...result!,
      settings,
      chatId: '-123',
      botId: 'bot',
      sourceCreatedAt: new Date().toISOString(),
      text: 'a',
    };
    expect(await enforcement.enqueue(params)).toMatchObject({
      kind: 'intent_accepted',
      intentId: expect.any(String),
    });
    expect(
      await enforcement.enqueue({
        ...params,
        binding: { ...params.binding, eventTimestampMs: Date.now() },
      }),
    ).toMatchObject({ kind: 'intent_accepted', intentId: expect.any(String) });
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
    ).toEqual({ kind: 'rejected', reason: 'policy_changed' });
    policy.resolve.mockResolvedValue({ mode: 'off' });
    expect(await enforcement.enqueue(params)).toEqual({
      kind: 'rejected',
      reason: 'policy_changed',
    });
    expect(intents.ensureIntentWithMessageActionClaim).toHaveBeenCalledTimes(2);
  });
});
