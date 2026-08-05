import type { MaxUpdate } from '@maxim/contracts';
import { ChatEntityType, WebhookStatus, type ChatSettings } from '../../prisma/prisma-client';
import { resolveDuplicateFlowConfig } from '../duplicate-flow-policy';
import {
  buildPhotoDuplicateActionBinding,
  PhotoDuplicateModerationService,
} from './photo-duplicate-moderation.service';
import type { PhotoDuplicateJob } from './photo-duplicate.queue';

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

function buildHarness(
  params: {
    status?: WebhookStatus;
    nextEnqueueAt?: Date | null;
    chatSettings?: ChatSettings;
    actionSettings?: ChatSettings;
    rolloutMode?: 'off' | 'shadow' | 'delete_only' | 'full';
    observationInserted?: boolean;
    repeatCount?: number;
    finalAccess?: { isAdmin: boolean; isOwner: boolean } | null;
    existingIntent?: {
      subjectUserId: string | null;
      reasons: Array<{
        userId: string | null;
        ruleCode: string;
        metadata: Record<string, unknown> | null;
      }>;
    } | null;
    existingModerationEvents?: Array<{
      userId: string;
      ruleCode: string;
      metadata: Record<string, unknown> | null;
    }>;
    existingActionClaims?: Array<{ userId: string; ruleCode: string }>;
    assertOwned?: jest.Mock;
  } = {},
) {
  const createdAt = new Date().toISOString();
  const normalizedUpdate = update(createdAt);
  const currentSettings = params.chatSettings ?? settings();
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
      findUnique: jest.fn().mockResolvedValue(params.existingIntent ?? null),
    },
    moderationEvent: {
      findFirst: jest.fn().mockResolvedValue(null),
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
      isAdmin: false,
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
  const analysisService = {
    analyzeAlbum: jest.fn().mockResolvedValue({
      kind: 'observed',
      albumHash: 'a'.repeat(64),
      imageCount: 1,
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
    }),
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
  const lease = { assertOwned };
  const job: PhotoDuplicateJob = {
    webhookEventId: 'event-1',
    chatId: 'chat-1',
    messageId: 'message-1',
    sourceCreatedAt: createdAt,
    algorithmVersion: 1,
  };
  return {
    service,
    job,
    lease,
    prisma,
    maxClient,
    maxBotContextService,
    analysisService,
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

  it('logs a positive shadow match at normal level without enforcing it', async () => {
    const harness = buildHarness({ rolloutMode: 'shadow', repeatCount: 0 });
    const log = jest.fn();
    (harness.service as any).logger = { log, debug: jest.fn(), warn: jest.fn() };

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ classification: 'duplicate', rolloutMode: 'shadow' }),
      'Photo duplicate match observed',
    );
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

  it('does not mutate image history when another moderation action owns the message', async () => {
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

    expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
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

    expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });

  it('does not apply a repeat count after the configured ladder changes during analysis', async () => {
    const harness = buildHarness({ actionSettings: settings({ duplicateWarnMaxCount: 5 }) });

    await harness.service.processPhotoDuplicateJob(harness.job, harness.lease);

    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalled();
    expect(harness.actions.executePhotoDuplicateAction).not.toHaveBeenCalled();
  });
});
