import type { MaxUpdate } from '@maxim/contracts';
import { ChatEntityType, WebhookStatus, type ChatSettings } from '../../prisma/prisma-client';
import { resolveDuplicateFlowConfig } from '../duplicate-flow-policy';
import {
  buildPhotoDuplicateActionBinding,
  PhotoDuplicateModerationService,
} from './photo-duplicate-moderation.service';
import {
  PHOTO_DUPLICATE_ALGORITHM_VERSION,
  type PhotoDuplicateJob,
} from './photo-duplicate.queue';

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
    rulesPublishedUrl: null,
    rulesPublishedMessageId: null,
  });
  return {
    duplicateSource: 'photo',
    photoDuplicateActionBindingVersion: 1,
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
    rolloutMode?: 'off' | 'shadow' | 'delete_only' | 'full';
    observationInserted?: boolean;
    repeatCount?: number;
    actionEligible?: boolean;
    initialAdmin?: boolean;
    finalAccess?: { isAdmin: boolean; isOwner: boolean } | null;
    manualReleaseAt?: Date | null;
    existingIntent?: MessageActionIntent | null;
    lateIntent?: MessageActionIntent | null;
    existingModerationEvents?: Array<{
      userId: string;
      ruleCode: string;
      metadata: Record<string, unknown> | null;
    }>;
    existingActionClaims?: Array<{ userId: string; ruleCode: string }>;
    assertOwned?: jest.Mock;
    resolveActionEligibility?: jest.Mock;
  } = {},
) {
  const createdAt = new Date().toISOString();
  const normalizedUpdate = update(createdAt);
  const currentSettings = params.chatSettings ?? settings();
  const manualRelease = params.manualReleaseAt ? { createdAt: params.manualReleaseAt } : null;
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
        .mockResolvedValue({
          entityType: ChatEntityType.CHAT,
          settings: params.actionSettings ?? currentSettings,
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
      findFirst: jest.fn().mockResolvedValue(manualRelease),
      findMany: jest.fn().mockResolvedValue(params.existingModerationEvents ?? []),
    },
    moderationViolationMessageClaim: {
      findMany: jest.fn().mockResolvedValue(params.existingActionClaims ?? []),
    },
  };
  const maxClient = {
    getChatMemberAccess: jest.fn().mockResolvedValue(
      params.finalAccess === null
        ? null
        : {
            userId: 'user-1',
            isAdmin: params.finalAccess?.isAdmin ?? false,
            isOwner: params.finalAccess?.isOwner ?? false,
            permissions: [],
          },
    ),
  };
  const moderationAccessService = {
    resolveSenderChatAdminCheck: jest.fn().mockResolvedValue({
      isAdmin: params.initialAdmin ?? false,
      source: 'remote',
    }),
  };
  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'PHOTO_DUPLICATE_ROLLOUT_MODE') return params.rolloutMode ?? 'full';
      if (key === 'PHOTO_DUPLICATE_ENFORCEMENT_CHAT_IDS') return 'chat-1';
      return undefined;
    }),
  };
  const maxBotLinkService = {
    getDefaultBotId: jest.fn().mockReturnValue('default-bot'),
  };
  const maxBotContextService = {
    runWithBot: jest.fn(async (_botId: string, operation: () => Promise<void>) => operation()),
  };
  const committedViolations: boolean[] = [];
  const analysisService = {
    analyzeAlbum: jest.fn().mockImplementation(
      async (analysisParams: {
        commitViolation: boolean;
        resolveActionEligibility: () => Promise<boolean>;
      }) => {
        const currentActionEligibility = await analysisParams.resolveActionEligibility();
        const actionEligible = analysisParams.commitViolation && currentActionEligibility;
        committedViolations.push(actionEligible);
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
            matchKind: 'pdq',
            matchedDistance: 4,
            repeatCount: params.repeatCount ?? 1,
            duplicateOfMessageId: 'message-0',
          },
        };
      },
    ),
  };
  const actions = {
    isPhotoDuplicateMessageAuthorImmune: jest.fn().mockReturnValue(false),
    consumePhotoDuplicateParticipantImmunity: jest.fn().mockResolvedValue(false),
    executePhotoDuplicateAction: jest.fn().mockResolvedValue(undefined),
  };
  const service = new PhotoDuplicateModerationService(
    prisma as never,
    analysisService as never,
    maxClient as never,
    moderationAccessService as never,
    configService as never,
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
    maxBotContextService,
    analysisService,
    committedViolations,
    actions,
  };
}

describe('PhotoDuplicateModerationService', () => {
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
    const harness = buildHarness({ observationInserted: false });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.maxBotContextService.runWithBot).toHaveBeenCalledWith(
      'execution-bot',
      expect.any(Function),
    );
    expect(harness.actions.executePhotoDuplicateAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actionClaimed: false,
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
      expect.objectContaining({ commitViolation: false }),
    );
    expect(harness.actions.consumePhotoDuplicateParticipantImmunity).not.toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('keeps an observation-only job non-actionable under an enforcing runtime policy', async () => {
    const harness = buildHarness({ actionEligible: false, repeatCount: 2 });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledWith(
      expect.objectContaining({ commitViolation: false }),
    );
    expect(harness.actions.consumePhotoDuplicateParticipantImmunity).not.toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('keeps a pre-commit downgrade absorbing even if a later confirmation could pass', async () => {
    const resolveActionEligibility = jest
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const harness = buildHarness({
      actionEligible: true,
      repeatCount: 2,
      resolveActionEligibility,
    });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledWith(
      expect.objectContaining({
        commitViolation: true,
        resolveActionEligibility,
      }),
    );
    expect(harness.committedViolations).toEqual([false]);
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

    expect(harness.committedViolations).toEqual([true]);
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

    expect(harness.committedViolations).toEqual([true]);
    expect(resolveActionEligibility).toHaveBeenCalledTimes(3);
    expect(harness.actions.consumePhotoDuplicateParticipantImmunity).toHaveBeenCalledTimes(1);
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('propagates an eligibility resolver failure before history and performs no action', async () => {
    const resolverError = new Error('ordering unavailable');
    const resolveActionEligibility = jest.fn().mockRejectedValue(resolverError);
    const harness = buildHarness({ repeatCount: 2, resolveActionEligibility });

    await expect(
      harness.service.processPhotoDuplicateJob(harness.job, harness.lease),
    ).rejects.toBe(resolverError);

    expect(harness.committedViolations).toEqual([]);
    expect(harness.actions.consumePhotoDuplicateParticipantImmunity).not.toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('keeps a recent manual release observation-only without consuming immunity', async () => {
    const harness = buildHarness({ manualReleaseAt: new Date(), repeatCount: 2 });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledWith(
      expect.objectContaining({ commitViolation: false }),
    );
    expect(harness.actions.consumePhotoDuplicateParticipantImmunity).not.toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
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
      expect.objectContaining({ commitViolation: false }),
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
      expect.objectContaining({ commitViolation: true }),
    );
    expect(harness.prisma.moderationDeleteIntent.findUnique).toHaveBeenCalledTimes(2);
    expect(harness.actions.consumePhotoDuplicateParticipantImmunity).not.toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('resumes only its exact bound photo action after a durable claim', async () => {
    const currentSettings = settings();
    const harness = buildHarness({
      observationInserted: false,
      chatSettings: currentSettings,
      existingIntent: ownPhotoIntent(currentSettings),
      existingActionClaims: [{ userId: 'user-1', ruleCode: 'DUPLICATE_MESSAGE_ACTION' }],
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
      existingActionClaims: [{ userId: 'user-1', ruleCode: 'DUPLICATE_MESSAGE_ACTION' }],
    });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalled();
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
      expect.objectContaining({ commitViolation: false }),
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
});
