import type { MaxUpdate } from '@maxim/contracts';
import { ChatEntityType, WebhookStatus, type ChatSettings } from '../../prisma/prisma-client';
import { resolveDuplicateFlowConfig } from '../duplicate-flow-policy';
import {
  buildPhotoDuplicateActionClaimDedupeKey,
  type PhotoDuplicateModerationActions,
} from './photo-duplicate-moderation.actions';
import {
  buildPhotoDuplicateActionBinding,
  PhotoDuplicateModerationService,
} from './photo-duplicate-moderation.service';
import { PHOTO_DUPLICATE_ALGORITHM_VERSION, type PhotoDuplicateJob } from './photo-duplicate.queue';
import { resolvePhotoDuplicateRuntimePolicy } from './photo-duplicate.runtime';

function settings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  return {
    antiDuplicateEnabled: true,
    duplicatePhotoEnabled: true,
    duplicatePhotoMatchPreset: 'SAME_IMAGE',
    duplicatePhotoScope: 'SAME_AUTHOR',
    duplicateWarnEnabled: false,
    duplicateWarnMaxCount: 2,
    duplicateWarnWindowSec: 3_600,
    duplicateMuteEnabled: false,
    duplicateMuteMaxCount: 3,
    duplicateMuteWindowSec: 3_600,
    duplicateBanEnabled: false,
    duplicateBanMaxCount: 4,
    duplicateBanWindowSec: 3_600,
    duplicateBotMessageEnabled: true,
    duplicateMuteDurationHours: 6,
    duplicateBotMessageText: '',
    duplicateBotButtons: [],
    duplicateBotButtonEnabled: false,
    duplicateBotButtonUrl: '',
    duplicateBotButtonText: 'Открыть',
    duplicateAdminContactButtonEnabled: false,
    duplicateAdminContactButtonUrl: '',
    rulesAttachViolationsEnabled: false,
    deleteBotMessagesEnabled: false,
    deleteBotMessagesDelayMinutes: 5,
    nightModeTimezone: 'Europe/Moscow',
    botSpeechStyle: null,
    botSpeechMedia: {},
    ...overrides,
  } as ChatSettings;
}

function update(createdAt: string): MaxUpdate {
  return {
    updateId: 'update-1',
    type: 'message_created',
    botId: 'delivery-bot',
    message: {
      chatId: 'chat-1',
      messageId: 'message-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: '',
      createdAt,
    },
    raw: {
      message: {
        body: {
          attachments: [
            {
              type: 'image',
              payload: {
                photo_id: 24149085858,
                url: 'https://i.oneme.ru/photo',
              },
            },
          ],
        },
      },
    },
  };
}

function photoBindingMetadata(bindingSettings: ChatSettings) {
  const binding = buildPhotoDuplicateActionBinding({
    settings: bindingSettings,
    flow: resolveDuplicateFlowConfig(bindingSettings),
    rolloutMode: 'full',
    intendedAction: 'HIT',
    matchKind: 'canonical_sha256',
    maxAction: 'DELETE_MESSAGE',
    rulesPublishedUrl: null,
    rulesPublishedMessageId: null,
  });
  return {
    duplicateSource: 'photo',
    photoDuplicateActionBindingVersion: 2,
    photoDuplicateIntendedAction: binding.intendedAction,
    photoDuplicateFlowConfigDigest: binding.configDigest,
  };
}

function ownPhotoIntent(bindingSettings: ChatSettings) {
  return {
    subjectUserId: 'user-1',
    reasons: [
      {
        userId: 'user-1',
        ruleCode: 'DUPLICATE_DELETE',
        metadata: photoBindingMetadata(bindingSettings),
      },
    ],
  };
}

function boundPhotoActionClaim(bindingSettings: ChatSettings) {
  const binding = buildPhotoDuplicateActionBinding({
    settings: bindingSettings,
    flow: resolveDuplicateFlowConfig(bindingSettings),
    rolloutMode: 'full',
    intendedAction: 'HIT',
    matchKind: 'canonical_sha256',
    maxAction: 'DELETE_MESSAGE',
    rulesPublishedUrl: null,
    rulesPublishedMessageId: null,
  });
  const actionBinding = {
    intendedAction: 'HIT' as const,
    configDigest: binding.configDigest,
  };
  return {
    dedupeKey: buildPhotoDuplicateActionClaimDedupeKey({
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'message-1',
      actionBinding,
    }),
    messageActionKey: 'v1:message-action',
    userId: 'user-1',
    ruleCode: 'DUPLICATE_MESSAGE_ACTION',
  };
}

type MessageActionIntent = {
  subjectUserId: string | null;
  reasons: Array<{
    userId: string | null;
    ruleCode: string;
    metadata: Record<string, unknown> | null;
  }>;
};

function buildHarness(
  params: {
    status?: WebhookStatus;
    nextEnqueueAt?: Date | null;
    chatSettings?: ChatSettings;
    actionSettings?: ChatSettings;
    dispatchSettings?: ChatSettings;
    sanctionSettings?: ChatSettings;
    rolloutMode?: 'off' | 'shadow' | 'delete_only' | 'full';
    allowedMatchKinds?: string;
    maxAction?: 'DELETE_MESSAGE' | 'WARN' | 'MUTE' | 'BAN';
    matchKind?: 'platform_id' | 'canonical_sha256' | 'pdq';
    policySnapshots?: Array<{
      mode: 'off' | 'shadow' | 'delete_only' | 'full';
      allowedMatchKinds: string;
      maxAction: 'DELETE_MESSAGE' | 'WARN' | 'MUTE' | 'BAN';
    }>;
    observationInserted?: boolean;
    repeatCount?: number;
    actionEligible?: boolean;
    initialAdmin?: boolean;
    finalAccess?: { isAdmin: boolean; isOwner: boolean } | null;
    sanctionAccess?: { isAdmin: boolean; isOwner: boolean } | null;
    manualReleaseAt?: Date | null;
    manualReleaseSnapshots?: Array<Date | null>;
    existingIntent?: MessageActionIntent | null;
    lateIntent?: MessageActionIntent | null;
    existingModerationEvents?: Array<{
      userId: string;
      ruleCode: string;
      metadata: Record<string, unknown> | null;
    }>;
    existingActionClaims?: Array<{
      dedupeKey?: string;
      messageActionKey?: string | null;
      userId: string;
      ruleCode: string;
    }>;
    actionClaimResult?: 'claimed' | 'resumed' | 'blocked';
    deleteIntentRollout?: 'off' | 'observed' | 'execute';
    participantImmune?: boolean;
    violationAlreadyCommitted?: boolean;
    assertOwned?: jest.Mock;
    resolveActionEligibility?: jest.Mock;
  } = {},
) {
  const createdAt = new Date().toISOString();
  const normalizedUpdate = update(createdAt);
  const currentSettings = params.chatSettings ?? settings();
  const actionSettings = params.actionSettings ?? currentSettings;
  const dispatchSettings = params.dispatchSettings ?? actionSettings;
  const sanctionSettings = params.sanctionSettings ?? dispatchSettings;
  const persistedActionClaims = [...(params.existingActionClaims ?? [])];
  const manualRelease = params.manualReleaseAt ? { createdAt: params.manualReleaseAt } : null;
  const manualReleaseLookup = jest.fn();
  for (const snapshot of params.manualReleaseSnapshots ?? []) {
    manualReleaseLookup.mockResolvedValueOnce(snapshot ? { createdAt: snapshot } : null);
  }
  manualReleaseLookup.mockResolvedValue(manualRelease);
  const prisma = {
    webhookEvent: {
      findUnique: jest.fn().mockResolvedValue({
        botId: 'webhook-bot',
        status: params.status ?? WebhookStatus.PROCESSED,
        nextEnqueueAt: params.nextEnqueueAt ?? null,
        normalizedPayload: normalizedUpdate,
        executionClaims: [{ executionBotId: 'execution-bot' }],
      }),
    },
    chat: {
      findUnique: jest
        .fn()
        .mockResolvedValueOnce({
          entityType: ChatEntityType.CHAT,
          settings: currentSettings,
          admins: [],
          rules: null,
        })
        .mockResolvedValueOnce({
          entityType: ChatEntityType.CHAT,
          settings: actionSettings,
          admins: [],
          rules: null,
        })
        .mockResolvedValueOnce({
          entityType: ChatEntityType.CHAT,
          settings: dispatchSettings,
          admins: [],
          rules: null,
        })
        .mockResolvedValue({
          entityType: ChatEntityType.CHAT,
          settings: sanctionSettings,
          admins: [],
          rules: null,
        }),
    },
    moderationDeleteIntent: {
      findUnique:
        params.lateIntent === undefined
          ? jest.fn().mockResolvedValue(params.existingIntent ?? null)
          : jest
              .fn()
              .mockResolvedValueOnce(params.existingIntent ?? null)
              .mockResolvedValue(params.lateIntent),
    },
    moderationEvent: {
      findFirst: manualReleaseLookup,
      findMany: jest.fn().mockResolvedValue(params.existingModerationEvents ?? []),
    },
    moderationViolationMessageClaim: {
      findMany: jest.fn().mockImplementation(async () => persistedActionClaims),
    },
  };
  const finalAccess =
    params.finalAccess === null
      ? null
      : {
          userId: 'user-1',
          isAdmin: params.finalAccess?.isAdmin ?? false,
          isOwner: params.finalAccess?.isOwner ?? false,
          permissions: [],
        };
  const sanctionAccess =
    params.sanctionAccess === undefined
      ? finalAccess
      : params.sanctionAccess === null
        ? null
        : {
            userId: 'user-1',
            isAdmin: params.sanctionAccess.isAdmin,
            isOwner: params.sanctionAccess.isOwner,
            permissions: [],
          };
  const maxClient = {
    getChatMemberAccess: jest
      .fn()
      .mockResolvedValueOnce(finalAccess)
      .mockResolvedValue(sanctionAccess),
  };
  const moderationAccessService = {
    resolveSenderChatAdminCheck: jest.fn().mockResolvedValue({
      isAdmin: params.initialAdmin ?? false,
      source: 'remote',
    }),
  };
  let policyReadIndex = -1;
  const readPolicySnapshot = () =>
    params.policySnapshots?.[
      Math.min(Math.max(policyReadIndex, 0), params.policySnapshots.length - 1)
    ];
  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'PHOTO_DUPLICATE_ROLLOUT_MODE') {
        policyReadIndex += 1;
        return readPolicySnapshot()?.mode ?? params.rolloutMode ?? 'full';
      }
      if (key === 'PHOTO_DUPLICATE_ENFORCEMENT_CHAT_IDS') return 'chat-1';
      if (key === 'PHOTO_DUPLICATE_ALLOWED_MATCH_KINDS') {
        return (
          readPolicySnapshot()?.allowedMatchKinds ?? params.allowedMatchKinds ?? 'canonical_sha256'
        );
      }
      if (key === 'PHOTO_DUPLICATE_MAX_ACTION') {
        return readPolicySnapshot()?.maxAction ?? params.maxAction ?? 'DELETE_MESSAGE';
      }
      return undefined;
    }),
  };
  const runtimePolicy = {
    resolveEffectivePolicy: jest.fn(
      (policyParams: {
        chatId: string;
        preset: 'SAME_IMAGE' | 'MINOR_EDITS';
        scope: 'SAME_AUTHOR' | 'CHAT';
      }) =>
        Promise.resolve(
          resolvePhotoDuplicateRuntimePolicy({
            ...policyParams,
            configService,
          }),
        ),
    ),
  };
  const moderationDeleteIntents = {
    getRolloutForRule: jest.fn().mockReturnValue(params.deleteIntentRollout ?? 'execute'),
  };
  const maxBotLinkService = {
    getDefaultBotId: jest.fn().mockReturnValue('default-bot'),
  };
  const maxBotContextService = {
    runWithBot: jest.fn(async (_botId: string, operation: () => Promise<void>) => operation()),
  };
  const committedViolations: boolean[] = [];
  let violationCommitted = params.violationAlreadyCommitted ?? false;
  const analysisService = {
    analyzeAlbum: jest
      .fn()
      .mockImplementation(
        async (analysisParams: {
          actionEligible: boolean;
          authorizationConfigDigest: string;
          allowedViolationMatchKinds: Array<'platform_id' | 'canonical_sha256' | 'pdq'>;
          resolveActionEligibility: () => Promise<boolean>;
        }) => {
          const matchKind = params.matchKind ?? 'canonical_sha256';
          const currentActionEligibility = await analysisParams.resolveActionEligibility();
          const actionEligible =
            analysisParams.actionEligible &&
            currentActionEligibility &&
            analysisParams.allowedViolationMatchKinds.includes(matchKind);
          return {
            kind: 'observed',
            albumHash: 'a'.repeat(64),
            imageCount: 1,
            actionEligible,
            observation: {
              kind: 'available',
              inserted: params.observationInserted ?? true,
              replayed: !(params.observationInserted ?? true),
              classification: 'duplicate',
              clusterId: 'c'.repeat(64),
              matchKind,
              matchedDistance: matchKind === 'pdq' ? 4 : 0,
              repeatCount: params.repeatCount ?? 1,
              duplicateOfMessageId: 'message-0',
              sanctionClusterId: 'e'.repeat(64),
              violationCommitted,
              authorization: {
                authorized: actionEligible,
                configDigest: analysisParams.authorizationConfigDigest,
              },
            },
          };
        },
      ),
    commitViolation: jest.fn().mockImplementation(
      async (commitParams: {
        expectedRepeatCount: number;
        matchKind: 'platform_id' | 'canonical_sha256' | 'pdq';
        allowedMatchKinds: Array<'platform_id' | 'canonical_sha256' | 'pdq'>;
        actionBinding: {
          intendedAction: 'NONE' | 'HIT' | 'WARN' | 'MUTE' | 'BAN';
          configDigest: string;
        };
      }) => {
        if (!commitParams.allowedMatchKinds.includes(commitParams.matchKind)) {
          return { kind: 'unavailable' };
        }
        const replayed = violationCommitted;
        if (!violationCommitted) {
          violationCommitted = true;
          committedViolations.push(true);
        }
        return {
          kind: 'available',
          committed: !replayed,
          replayed,
          repeatCount: commitParams.expectedRepeatCount,
          sanctionClusterId: 'e'.repeat(64),
          bindingMatches: true,
          actionBinding: commitParams.actionBinding,
        };
      },
    ),
  };
  const actions = {
    isPhotoDuplicateMessageAuthorImmune: jest.fn().mockReturnValue(false),
    consumePhotoDuplicateParticipantImmunity: jest
      .fn()
      .mockResolvedValue(params.participantImmune ?? false),
    claimPhotoDuplicateAction: jest.fn().mockImplementation(async (
      claimParams: Parameters<PhotoDuplicateModerationActions['claimPhotoDuplicateAction']>[0],
    ) => {
      const result = params.actionClaimResult ?? 'claimed';
      if (result === 'claimed') {
        persistedActionClaims.push({
          dedupeKey: buildPhotoDuplicateActionClaimDedupeKey(claimParams),
          messageActionKey: 'v1:claimed-photo-action',
          userId: claimParams.userId,
          ruleCode: 'DUPLICATE_MESSAGE_ACTION',
        });
      }
      return result;
    }),
    executePhotoDuplicateAction: jest.fn().mockResolvedValue(undefined),
  };
  const service = new PhotoDuplicateModerationService(
    prisma as never,
    analysisService as never,
    maxClient as never,
    moderationAccessService as never,
    moderationDeleteIntents as never,
    runtimePolicy as never,
    maxBotContextService as never,
    maxBotLinkService as never,
    actions,
  );
  const assertOwned = params.assertOwned ?? jest.fn();
  const resolveActionEligibility =
    params.resolveActionEligibility ?? jest.fn().mockResolvedValue(true);
  const lease = { assertOwned, resolveActionEligibility };
  const job: PhotoDuplicateJob = {
    webhookEventId: 'event-1',
    chatId: 'chat-1',
    messageId: 'message-1',
    sourceCreatedAt: createdAt,
    algorithmVersion: PHOTO_DUPLICATE_ALGORITHM_VERSION,
    actionEligible: params.actionEligible ?? true,
  };
  return {
    service,
    job,
    lease,
    prisma,
    maxClient,
    moderationDeleteIntents,
    maxBotContextService,
    analysisService,
    runtimePolicy,
    committedViolations,
    actions,
  };
}

function readSanctionAuthorization(harness: ReturnType<typeof buildHarness>) {
  const request = harness.actions.executePhotoDuplicateAction.mock.calls[0]?.[0];
  if (!request || request.outcome.kind !== 'decision' || !('authorizeSanction' in request)) {
    throw new Error('Expected a photo duplicate sanction request');
  }
  return request.authorizeSanction as () => Promise<boolean>;
}

function readDeleteAuthorization(harness: ReturnType<typeof buildHarness>) {
  const request = harness.actions.executePhotoDuplicateAction.mock.calls[0]?.[0];
  if (!request || typeof request.authorizeDelete !== 'function') {
    throw new Error('Expected a photo duplicate delete request');
  }
  return request.authorizeDelete;
}

describe('PhotoDuplicateModerationService', () => {
  it('does no image work when the global photo rollout is off', async () => {
    const harness = buildHarness({ rolloutMode: 'off' });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it.each(['off', 'observed'] as const)(
    'keeps photo duplicates observation-only when durable delete rollout is %s',
    async (deleteIntentRollout) => {
      const harness = buildHarness({ deleteIntentRollout, repeatCount: 2 });

      await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

      expect(harness.moderationDeleteIntents.getRolloutForRule).toHaveBeenCalledWith(
        'chat-1',
        'DUPLICATE_DELETE',
      );
      expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledWith(
        expect.objectContaining({ actionEligible: false }),
      );
      expect(harness.actions.claimPhotoDuplicateAction).not.toHaveBeenCalled();
      expect(harness.analysisService.commitViolation).not.toHaveBeenCalled();
      expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
    },
  );

  it('retries while the canonical webhook is still processing', async () => {
    const harness = buildHarness({ status: WebhookStatus.QUEUED });

    await expect(
      harness.service.processPhotoDuplicateJob(harness.job, harness.lease),
    ).rejects.toThrow(/not processed yet/u);
    expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
  });

  it('does no image work when the setting is disabled after enqueue', async () => {
    const harness = buildHarness({ chatSettings: settings({ duplicatePhotoEnabled: false }) });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
  });

  it('does no image work when a stale enqueue is later resolved to an admin', async () => {
    const harness = buildHarness({ initialAdmin: true });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
    expect(harness.actions.consumePhotoDuplicateParticipantImmunity).not.toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('runs a replayed match through the focused actions port in the execution bot context', async () => {
    const harness = buildHarness({
      observationInserted: false,
      violationAlreadyCommitted: true,
    });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.maxBotContextService.runWithBot).toHaveBeenCalledWith(
      'execution-bot',
      expect.any(Function),
    );
    expect(harness.actions.executePhotoDuplicateAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actionClaimed: true,
        lease: harness.lease,
        outcome: expect.objectContaining({
          kind: 'hit',
          hit: expect.objectContaining({
            fingerprintType: 'image',
            metadata: expect.objectContaining({
              duplicateSource: 'photo',
              photoDuplicateIntendedAction: 'HIT',
              photoDuplicateFlowConfigDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
            }),
          }),
        }),
      }),
    );
  });

  it('durably claims the bound action before committing its Redis counter', async () => {
    const harness = buildHarness();

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.actions.claimPhotoDuplicateAction).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        messageId: 'message-1',
        actionBinding: expect.objectContaining({ intendedAction: 'HIT' }),
      }),
    );
    expect(harness.actions.claimPhotoDuplicateAction.mock.invocationCallOrder[0]).toBeLessThan(
      harness.analysisService.commitViolation.mock.invocationCallOrder[0],
    );
    expect(harness.analysisService.commitViolation.mock.invocationCallOrder[0]).toBeLessThan(
      harness.actions.executePhotoDuplicateAction.mock.invocationCallOrder[0],
    );
    expect(harness.actions.executePhotoDuplicateAction).toHaveBeenCalledWith(
      expect.objectContaining({ actionClaimed: true }),
    );
  });

  it('revalidates the durable claim and current policy immediately before deletion', async () => {
    const harness = buildHarness();

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    await expect(readDeleteAuthorization(harness)()).resolves.toBe(true);
    expect(harness.maxClient.getChatMemberAccess).toHaveBeenLastCalledWith(
      'chat-1',
      'user-1',
      expect.objectContaining({ bypassCache: true }),
    );
    expect(harness.maxClient.getChatMemberAccess.mock.invocationCallOrder[1]).toBeLessThan(
      harness.runtimePolicy.resolveEffectivePolicy.mock.invocationCallOrder.at(-1)!,
    );
  });

  it('revokes a pending deletion when the shared runtime control is cleared', async () => {
    const enforcingPolicy = {
      mode: 'full' as const,
      allowedMatchKinds: 'canonical_sha256',
      maxAction: 'DELETE_MESSAGE' as const,
    };
    const harness = buildHarness({
      policySnapshots: [
        enforcingPolicy,
        enforcingPolicy,
        enforcingPolicy,
        enforcingPolicy,
        { ...enforcingPolicy, mode: 'off' },
      ],
    });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    await expect(readDeleteAuthorization(harness)()).resolves.toBe(false);
  });

  it('revalidates the durable claim and current policy immediately before a sanction', async () => {
    const warningSettings = settings({
      duplicateBotMessageEnabled: false,
      duplicateWarnEnabled: true,
      duplicateWarnMaxCount: 2,
    });
    const harness = buildHarness({
      chatSettings: warningSettings,
      maxAction: 'WARN',
      repeatCount: 2,
    });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    await expect(readSanctionAuthorization(harness)()).resolves.toBe(true);
    expect(harness.maxClient.getChatMemberAccess).toHaveBeenLastCalledWith(
      'chat-1',
      'user-1',
      expect.objectContaining({ bypassCache: true }),
    );
    expect(harness.maxClient.getChatMemberAccess.mock.invocationCallOrder[1]).toBeLessThan(
      harness.runtimePolicy.resolveEffectivePolicy.mock.invocationCallOrder.at(-1)!,
    );
  });

  it('revokes a pending sanction when Anti-duplicate is disabled during DELETE', async () => {
    const warningSettings = settings({
      duplicateBotMessageEnabled: false,
      duplicateWarnEnabled: true,
      duplicateWarnMaxCount: 2,
    });
    const harness = buildHarness({
      chatSettings: warningSettings,
      sanctionSettings: settings({
        ...warningSettings,
        antiDuplicateEnabled: false,
      }),
      maxAction: 'WARN',
      repeatCount: 2,
    });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    await expect(readSanctionAuthorization(harness)()).resolves.toBe(false);
  });

  it('revokes a pending sanction when the runtime ceiling is lowered during DELETE', async () => {
    const warningSettings = settings({
      duplicateBotMessageEnabled: false,
      duplicateWarnEnabled: true,
      duplicateWarnMaxCount: 2,
    });
    const fullPolicy = {
      mode: 'full' as const,
      allowedMatchKinds: 'canonical_sha256',
      maxAction: 'WARN' as const,
    };
    const harness = buildHarness({
      chatSettings: warningSettings,
      repeatCount: 2,
      policySnapshots: [
        fullPolicy,
        fullPolicy,
        fullPolicy,
        fullPolicy,
        { ...fullPolicy, maxAction: 'DELETE_MESSAGE' },
      ],
    });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    await expect(readSanctionAuthorization(harness)()).resolves.toBe(false);
  });

  it('revokes a pending sanction when the author becomes an admin during DELETE', async () => {
    const warningSettings = settings({
      duplicateBotMessageEnabled: false,
      duplicateWarnEnabled: true,
      duplicateWarnMaxCount: 2,
    });
    const harness = buildHarness({
      chatSettings: warningSettings,
      maxAction: 'WARN',
      repeatCount: 2,
      sanctionAccess: { isAdmin: true, isOwner: false },
    });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    await expect(readSanctionAuthorization(harness)()).resolves.toBe(false);
  });

  it('revokes a pending sanction after a manual release or lost ordering eligibility', async () => {
    const warningSettings = settings({
      duplicateBotMessageEnabled: false,
      duplicateWarnEnabled: true,
      duplicateWarnMaxCount: 2,
    });
    const released = buildHarness({
      chatSettings: warningSettings,
      maxAction: 'WARN',
      repeatCount: 2,
      manualReleaseSnapshots: [null, null, null, new Date()],
    });
    await released.service.processPhotoDuplicateJob(released.job, released.lease);
    await expect(readSanctionAuthorization(released)()).resolves.toBe(false);

    const leaseLost = buildHarness({
      chatSettings: warningSettings,
      maxAction: 'WARN',
      repeatCount: 2,
    });
    await leaseLost.service.processPhotoDuplicateJob(leaseLost.job, leaseLost.lease);
    leaseLost.lease.resolveActionEligibility.mockResolvedValue(false);
    await expect(readSanctionAuthorization(leaseLost)()).resolves.toBe(false);
  });

  it('does not commit when a concurrent rule wins the durable message action claim', async () => {
    const harness = buildHarness({ actionClaimResult: 'blocked' });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.actions.claimPhotoDuplicateAction).toHaveBeenCalledTimes(1);
    expect(harness.analysisService.commitViolation).not.toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('commits an immutable NONE binding below the deletion threshold without claiming an action', async () => {
    const belowThresholdSettings = settings({ duplicateWarnMaxCount: 3 });
    const harness = buildHarness({ chatSettings: belowThresholdSettings, repeatCount: 1 });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.actions.claimPhotoDuplicateAction).not.toHaveBeenCalled();
    expect(harness.analysisService.commitViolation).toHaveBeenCalledWith(
      expect.objectContaining({
        actionBinding: expect.objectContaining({ intendedAction: 'NONE' }),
      }),
    );
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('resumes an exact bound claim even when no delete intent exists yet', async () => {
    const currentSettings = settings();
    const harness = buildHarness({
      observationInserted: false,
      violationAlreadyCommitted: true,
      chatSettings: currentSettings,
      existingActionClaims: [boundPhotoActionClaim(currentSettings)],
    });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.actions.claimPhotoDuplicateAction).not.toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).toHaveBeenCalledWith(
      expect.objectContaining({ actionClaimed: true }),
    );
  });

  it('rejects a durable photo claim whose immutable binding differs', async () => {
    const harness = buildHarness({
      existingActionClaims: [
        boundPhotoActionClaim(settings({ duplicateBotMessageText: 'old explanation' })),
      ],
    });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.analysisService.commitViolation).not.toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('logs a positive shadow match without committing a counter or consuming immunity', async () => {
    const harness = buildHarness({ rolloutMode: 'shadow', repeatCount: 2 });
    const log = jest.fn();
    (harness.service as any).logger = { log, debug: jest.fn(), warn: jest.fn() };

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ classification: 'duplicate', rolloutMode: 'shadow' }),
      'Photo duplicate match observed',
    );
    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledWith(
      expect.objectContaining({ actionEligible: false }),
    );
    expect(harness.actions.consumePhotoDuplicateParticipantImmunity).not.toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('keeps a PDQ match observation-only under the canonical enforcement default', async () => {
    const harness = buildHarness({ matchKind: 'pdq', repeatCount: 2 });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedViolationMatchKinds: ['canonical_sha256'],
        actionEligible: true,
      }),
    );
    expect(harness.committedViolations).toEqual([]);
    expect(harness.analysisService.commitViolation).not.toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('allows a PDQ match only when its match kind is explicitly enabled', async () => {
    const harness = buildHarness({
      allowedMatchKinds: 'canonical_sha256,pdq',
      matchKind: 'pdq',
    });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.committedViolations).toEqual([true]);
    expect(harness.actions.executePhotoDuplicateAction).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: expect.objectContaining({ kind: 'hit' }) }),
    );
  });

  it.each([
    ['DELETE_MESSAGE', 'hit', null],
    ['WARN', 'decision', 'WARN'],
    ['MUTE', 'decision', 'MUTE'],
    ['BAN', 'decision', 'BAN'],
  ] as const)(
    'caps a full photo BAN decision at %s',
    async (maxAction, expectedKind, expectedAction) => {
      const ladderSettings = settings({
        duplicateBotMessageEnabled: false,
        duplicateWarnEnabled: true,
        duplicateMuteEnabled: true,
        duplicateBanEnabled: true,
      });
      const harness = buildHarness({
        chatSettings: ladderSettings,
        maxAction,
        repeatCount: 4,
      });

      await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

      const request = harness.actions.executePhotoDuplicateAction.mock.calls[0]?.[0];
      expect(request?.outcome.kind).toBe(expectedKind);
      if (expectedAction) {
        expect(request?.outcome).toMatchObject({
          kind: 'decision',
          decision: { action: expectedAction },
        });
      }
    },
  );

  it('falls back to delete-only when only BAN is enabled but the ceiling is MUTE', async () => {
    const sparseSettings = settings({
      duplicateBotMessageEnabled: false,
      duplicateWarnEnabled: false,
      duplicateMuteEnabled: false,
      duplicateBanEnabled: true,
    });
    const harness = buildHarness({
      chatSettings: sparseSettings,
      maxAction: 'MUTE',
      repeatCount: 4,
    });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.actions.executePhotoDuplicateAction).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: expect.objectContaining({ kind: 'hit' }) }),
    );
  });

  it('keeps MUTE when WARN is disabled and MUTE is enabled at the MUTE ceiling', async () => {
    const sparseSettings = settings({
      duplicateBotMessageEnabled: false,
      duplicateWarnEnabled: false,
      duplicateMuteEnabled: true,
      duplicateBanEnabled: false,
    });
    const harness = buildHarness({
      chatSettings: sparseSettings,
      maxAction: 'MUTE',
      repeatCount: 3,
    });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.actions.executePhotoDuplicateAction).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: expect.objectContaining({
          kind: 'decision',
          decision: expect.objectContaining({ action: 'MUTE' }),
        }),
      }),
    );
  });

  it('does not expose a disabled or above-ceiling next action', async () => {
    const sparseSettings = settings({
      duplicateBotMessageEnabled: false,
      duplicateWarnEnabled: true,
      duplicateMuteEnabled: false,
      duplicateBanEnabled: true,
    });
    const harness = buildHarness({
      chatSettings: sparseSettings,
      maxAction: 'MUTE',
      repeatCount: 2,
    });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.actions.executePhotoDuplicateAction).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: expect.objectContaining({
          kind: 'decision',
          decision: expect.objectContaining({ action: 'WARN', nextAction: null }),
        }),
      }),
    );
  });

  it('keeps delete_only non-sanctioning even when the maximum action permits BAN', async () => {
    const ladderSettings = settings({
      duplicateBotMessageEnabled: false,
      duplicateWarnEnabled: true,
      duplicateMuteEnabled: true,
      duplicateBanEnabled: true,
    });
    const harness = buildHarness({
      chatSettings: ladderSettings,
      rolloutMode: 'delete_only',
      maxAction: 'BAN',
      repeatCount: 4,
    });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.actions.executePhotoDuplicateAction).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: expect.objectContaining({ kind: 'hit' }) }),
    );
  });

  it('re-reads the action ceiling and stops when it is lowered before dispatch', async () => {
    const ladderSettings = settings({
      duplicateBotMessageEnabled: false,
      duplicateWarnEnabled: true,
      duplicateMuteEnabled: true,
      duplicateBanEnabled: true,
    });
    const harness = buildHarness({
      chatSettings: ladderSettings,
      repeatCount: 4,
      policySnapshots: [
        { mode: 'full', allowedMatchKinds: 'canonical_sha256', maxAction: 'BAN' },
        { mode: 'full', allowedMatchKinds: 'canonical_sha256', maxAction: 'BAN' },
        { mode: 'full', allowedMatchKinds: 'canonical_sha256', maxAction: 'DELETE_MESSAGE' },
      ],
    });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.committedViolations).toEqual([]);
    expect(harness.analysisService.commitViolation).not.toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('re-reads allowed match kinds and stops when the kind is removed before dispatch', async () => {
    const harness = buildHarness({
      policySnapshots: [
        { mode: 'full', allowedMatchKinds: 'canonical_sha256', maxAction: 'DELETE_MESSAGE' },
        { mode: 'full', allowedMatchKinds: 'canonical_sha256', maxAction: 'DELETE_MESSAGE' },
        { mode: 'full', allowedMatchKinds: '', maxAction: 'DELETE_MESSAGE' },
      ],
    });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.committedViolations).toEqual([]);
    expect(harness.analysisService.commitViolation).not.toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('keeps an observation-only job non-actionable under an enforcing runtime policy', async () => {
    const harness = buildHarness({ actionEligible: false, repeatCount: 2 });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledWith(
      expect.objectContaining({ actionEligible: false }),
    );
    expect(harness.actions.consumePhotoDuplicateParticipantImmunity).not.toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('keeps a pre-commit downgrade absorbing even if a later confirmation could pass', async () => {
    const resolveActionEligibility = jest.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const harness = buildHarness({
      actionEligible: true,
      repeatCount: 2,
      resolveActionEligibility,
    });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledWith(
      expect.objectContaining({
        actionEligible: true,
        resolveActionEligibility,
      }),
    );
    expect(harness.committedViolations).toEqual([]);
    expect(resolveActionEligibility).toHaveBeenCalledTimes(1);
    expect(harness.actions.consumePhotoDuplicateParticipantImmunity).not.toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('stops before participant immunity when the latch is downgraded after observation', async () => {
    const resolveActionEligibility = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const harness = buildHarness({ repeatCount: 2, resolveActionEligibility });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.committedViolations).toEqual([]);
    expect(resolveActionEligibility).toHaveBeenCalledTimes(2);
    expect(harness.actions.consumePhotoDuplicateParticipantImmunity).not.toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('stops before dispatch when the latch is downgraded after immunity', async () => {
    const resolveActionEligibility = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const harness = buildHarness({ repeatCount: 2, resolveActionEligibility });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.committedViolations).toEqual([]);
    expect(resolveActionEligibility).toHaveBeenCalledTimes(3);
    expect(harness.actions.consumePhotoDuplicateParticipantImmunity).toHaveBeenCalledTimes(1);
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('propagates an eligibility resolver failure before history and performs no action', async () => {
    const resolverError = new Error('ordering unavailable');
    const resolveActionEligibility = jest.fn().mockRejectedValue(resolverError);
    const harness = buildHarness({ repeatCount: 2, resolveActionEligibility });

    await expect(harness.service.processPhotoDuplicateJob(harness.job, harness.lease)).rejects.toBe(
      resolverError,
    );

    expect(harness.committedViolations).toEqual([]);
    expect(harness.actions.consumePhotoDuplicateParticipantImmunity).not.toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('keeps a recent manual release observation-only without consuming immunity', async () => {
    const harness = buildHarness({ manualReleaseAt: new Date(), repeatCount: 2 });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledWith(
      expect.objectContaining({ actionEligible: false }),
    );
    expect(harness.actions.consumePhotoDuplicateParticipantImmunity).not.toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('does not commit when a manual release appears after photo analysis', async () => {
    const harness = buildHarness({
      repeatCount: 2,
      manualReleaseSnapshots: [null, new Date()],
    });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledWith(
      expect.objectContaining({ actionEligible: true }),
    );
    expect(harness.committedViolations).toEqual([]);
    expect(harness.analysisService.commitViolation).not.toHaveBeenCalled();
    expect(harness.actions.consumePhotoDuplicateParticipantImmunity).not.toHaveBeenCalled();
  });

  it('fails open when the sender becomes an admin during image analysis', async () => {
    const harness = buildHarness({ finalAccess: { isAdmin: true, isOwner: false } });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalled();
    expect(harness.maxClient.getChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      'user-1',
      expect.objectContaining({ bypassCache: true, trafficClass: 'background' }),
    );
    expect(harness.analysisService.commitViolation).not.toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('observes a baseline without committing a counter when another action owns the message', async () => {
    const harness = buildHarness({
      existingIntent: {
        subjectUserId: 'user-1',
        reasons: [
          {
            userId: 'user-1',
            ruleCode: 'DUPLICATE_DELETE',
            metadata: photoBindingMetadata(settings()),
          },
          { userId: 'user-1', ruleCode: 'LINK_DELETE', metadata: null },
        ],
      },
    });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledWith(
      expect.objectContaining({ actionEligible: false }),
    );
    expect(harness.actions.consumePhotoDuplicateParticipantImmunity).not.toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('allows a late foreign action fence only to suppress the photo action', async () => {
    const harness = buildHarness({
      lateIntent: {
        subjectUserId: 'user-2',
        reasons: [
          {
            userId: 'user-2',
            ruleCode: 'LINK_DELETE',
            metadata: null,
          },
        ],
      },
    });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledWith(
      expect.objectContaining({ actionEligible: true }),
    );
    expect(harness.prisma.moderationDeleteIntent.findUnique).toHaveBeenCalledTimes(2);
    expect(harness.committedViolations).toEqual([]);
    expect(harness.analysisService.commitViolation).not.toHaveBeenCalled();
    expect(harness.actions.consumePhotoDuplicateParticipantImmunity).not.toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('resumes only its exact bound photo action after a durable claim', async () => {
    const currentSettings = settings();
    const harness = buildHarness({
      observationInserted: false,
      violationAlreadyCommitted: true,
      chatSettings: currentSettings,
      existingIntent: ownPhotoIntent(currentSettings),
      existingActionClaims: [boundPhotoActionClaim(currentSettings)],
    });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.actions.executePhotoDuplicateAction).toHaveBeenCalledWith(
      expect.objectContaining({ actionClaimed: true, lease: harness.lease }),
    );
  });

  it('rejects recovery when the duplicate flow changed after the claim', async () => {
    const claimedSettings = settings();
    const changedSettings = settings({ duplicateWarnWindowSec: 7_200 });
    const harness = buildHarness({
      observationInserted: false,
      chatSettings: changedSettings,
      existingIntent: ownPhotoIntent(claimedSettings),
      existingActionClaims: [boundPhotoActionClaim(claimedSettings)],
    });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('does not infer photo ownership from a legacy generic claim and matching intent', async () => {
    const currentSettings = settings();
    const harness = buildHarness({
      observationInserted: false,
      violationAlreadyCommitted: true,
      chatSettings: currentSettings,
      existingIntent: ownPhotoIntent(currentSettings),
      existingActionClaims: [{ userId: 'user-1', ruleCode: 'DUPLICATE_MESSAGE_ACTION' }],
    });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledWith(
      expect.objectContaining({ actionEligible: false }),
    );
    expect(harness.analysisService.commitViolation).not.toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('stops before action dispatch when the active ordering lease is lost', async () => {
    const leaseLost = new Error('ordering lease lost');
    let assertions = 0;
    const assertOwned = jest.fn(() => {
      assertions += 1;
      if (assertions === 5) throw leaseLost;
    });
    const harness = buildHarness({ assertOwned });

    await expect(harness.service.processPhotoDuplicateJob(harness.job, harness.lease)).rejects.toBe(
      leaseLost,
    );

    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalled();
    expect(harness.actions.consumePhotoDuplicateParticipantImmunity).not.toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('treats a completed photo sanction as terminal recovery state', async () => {
    const currentSettings = settings();
    const harness = buildHarness({
      existingIntent: ownPhotoIntent(currentSettings),
      existingActionClaims: [{ userId: 'user-1', ruleCode: 'DUPLICATE_MESSAGE_ACTION' }],
      existingModerationEvents: [
        {
          userId: 'user-1',
          ruleCode: 'DUPLICATE_MUTE',
          metadata: { duplicateSource: 'photo' },
        },
      ],
    });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledWith(
      expect.objectContaining({ actionEligible: false }),
    );
    expect(harness.actions.consumePhotoDuplicateParticipantImmunity).not.toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('does not apply a repeat count after the configured ladder changes during analysis', async () => {
    const harness = buildHarness({ actionSettings: settings({ duplicateWarnMaxCount: 5 }) });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('does not dispatch after the photo toggle is disabled following the counter commit', async () => {
    const harness = buildHarness({
      dispatchSettings: settings({ duplicatePhotoEnabled: false }),
    });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.committedViolations).toEqual([true]);
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('does not dispatch a stale sanction when the ladder changes after the counter commit', async () => {
    const actionSettings = settings({
      duplicateBotMessageEnabled: false,
      duplicateWarnEnabled: true,
      duplicateMuteEnabled: true,
    });
    const harness = buildHarness({
      chatSettings: actionSettings,
      repeatCount: 3,
      maxAction: 'MUTE',
      dispatchSettings: settings({
        ...actionSettings,
        duplicateMuteEnabled: false,
      }),
    });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.committedViolations).toEqual([true]);
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('commits an allowed repeat even when it has not reached the action threshold', async () => {
    const currentSettings = settings({ duplicateBotMessageEnabled: false });
    const harness = buildHarness({ chatSettings: currentSettings, repeatCount: 1 });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.committedViolations).toEqual([true]);
    expect(harness.actions.consumePhotoDuplicateParticipantImmunity).not.toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('does not commit a sanction counter when participant immunity is consumed', async () => {
    const harness = buildHarness({ participantImmune: true, repeatCount: 2 });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.actions.consumePhotoDuplicateParticipantImmunity).toHaveBeenCalledTimes(1);
    expect(harness.committedViolations).toEqual([]);
    expect(harness.analysisService.commitViolation).not.toHaveBeenCalled();
  });

  it('replays the atomic counter commit without incrementing twice', async () => {
    const harness = buildHarness({ repeatCount: 2 });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);
    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.analysisService.commitViolation).toHaveBeenCalledTimes(2);
    expect(harness.committedViolations).toEqual([true]);
  });
});
