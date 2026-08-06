import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MaxUpdate } from '@maxim/contracts';
import { createHash } from 'node:crypto';
import { MaxBotContextService } from '../../max/max-bot-context.service';
import { MaxBotLinkService } from '../../max/max-bot-link.service';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../../max/max-client.service';
import { ChatEntityType, WebhookStatus, type ChatSettings } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  duplicateFlowConfigsEqual,
  resolveDuplicateFlowConfig,
  resolveDuplicateFlowOutcome,
  type DuplicateFlowConfig,
} from '../duplicate-flow-policy';
import { ModerationAccessService } from '../moderation-access.service';
import {
  DEFAULT_CHAT_ADMIN_LOOKUP_TIMEOUT_MS,
  type ChatAdminCheckResult,
} from '../moderation.service.support';
import type { DuplicateAction } from '../rule-engine.contract';
import {
  extractLogicalPhotoAlbumResult,
  type LogicalPhotoAlbum,
} from './photo-attachment-extractor';
import { PhotoDuplicateAnalysisService } from './photo-duplicate-analysis.service';
import {
  PHOTO_DUPLICATE_MODERATION_ACTIONS,
  type PhotoDuplicateModerationActions,
} from './photo-duplicate-moderation.actions';
import type { PhotoDuplicateOrderingLease } from './photo-duplicate-ordering.store';
import {
  PHOTO_DUPLICATE_ALGORITHM_VERSION,
  PhotoDuplicateSourceNotReadyError,
  type PhotoDuplicateJob,
} from './photo-duplicate.queue';
import {
  resolvePhotoDuplicateRuntimePolicy,
  type PhotoDuplicateRolloutMode,
} from './photo-duplicate.runtime';
import { PHOTO_FINGERPRINT_ALGORITHM_VERSION } from './photo-fingerprint';

const DUPLICATE_MESSAGE_ACTION_CLAIM_RULE_CODE = 'DUPLICATE_MESSAGE_ACTION';
const PHOTO_DUPLICATE_ACTION_BINDING_VERSION = 1;

export type PhotoDuplicateIntendedAction = 'HIT' | DuplicateAction;

export type PhotoDuplicateActionBinding = {
  intendedAction: PhotoDuplicateIntendedAction;
  configDigest: string;
};

type PhotoDuplicateJobContext = {
  entityType: ChatEntityType;
  settings: ChatSettings;
  adminUserIds: string[];
  rulesPublishedUrl: string | null;
  rulesPublishedMessageId: string | null;
};

type PhotoDuplicateMessageActionFence = {
  blocked: boolean;
  actionClaimed: boolean;
  persistedBinding: PhotoDuplicateActionBinding | null;
};

@Injectable()
export class PhotoDuplicateModerationService {
  private readonly logger = new Logger(PhotoDuplicateModerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly analysisService: PhotoDuplicateAnalysisService,
    private readonly maxClient: MaxClientService,
    private readonly moderationAccessService: ModerationAccessService,
    private readonly configService: ConfigService,
    private readonly maxBotContextService: MaxBotContextService,
    private readonly maxBotLinkService: MaxBotLinkService,
    @Inject(PHOTO_DUPLICATE_MODERATION_ACTIONS)
    private readonly actions: PhotoDuplicateModerationActions,
  ) {}

  async processPhotoDuplicateJob(
    job: PhotoDuplicateJob,
    lease: PhotoDuplicateOrderingLease,
  ): Promise<void> {
    lease.assertOwned();
    if (job.algorithmVersion !== PHOTO_DUPLICATE_ALGORITHM_VERSION) {
      return;
    }

    const webhookEvent = await this.prisma.webhookEvent.findUnique({
      where: { id: job.webhookEventId },
      select: {
        botId: true,
        status: true,
        nextEnqueueAt: true,
        normalizedPayload: true,
        executionClaims: {
          where: { kind: 'EXECUTION' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { executionBotId: true },
        },
      },
    });
    lease.assertOwned();
    if (
      !webhookEvent ||
      webhookEvent.status === WebhookStatus.DUPLICATE ||
      (webhookEvent.status === WebhookStatus.FAILED && webhookEvent.nextEnqueueAt === null)
    ) {
      return;
    }
    if (webhookEvent.status !== WebhookStatus.PROCESSED) {
      throw new PhotoDuplicateSourceNotReadyError(job.webhookEventId);
    }

    const update = webhookEvent.normalizedPayload as MaxUpdate;
    const extraction = extractLogicalPhotoAlbumResult(update);
    if (extraction.kind !== 'complete') {
      return;
    }
    const { album } = extraction;
    if (
      album.chatId !== job.chatId ||
      album.messageId !== job.messageId ||
      album.createdAtMs !== Date.parse(job.sourceCreatedAt)
    ) {
      this.logger.warn(
        { webhookEventId: job.webhookEventId },
        'Skipped photo duplicate job whose source identity does not match the webhook',
      );
      return;
    }

    const updateRecord = update as unknown as Record<string, unknown>;
    const activeBotId =
      readString(webhookEvent.executionClaims[0]?.executionBotId) ??
      readString(webhookEvent.botId) ??
      readString(updateRecord.executionOwnerBotId) ??
      readString(update.botId) ??
      this.maxBotLinkService.getDefaultBotId() ??
      null;
    const execute = async () => {
      lease.assertOwned();
      await this.processPhotoDuplicateAlbum(update, album, job.actionEligible === true, lease);
    };
    if (activeBotId) {
      await this.maxBotContextService.runWithBot(activeBotId, execute);
      return;
    }
    await execute();
  }

  private async processPhotoDuplicateAlbum(
    update: MaxUpdate,
    album: LogicalPhotoAlbum,
    jobActionEligible: boolean,
    lease: PhotoDuplicateOrderingLease,
  ): Promise<void> {
    if (this.actions.isPhotoDuplicateMessageAuthorImmune({ update, album })) {
      return;
    }

    const initialContext = await this.loadJobContext(album.chatId);
    if (
      !initialContext ||
      initialContext.entityType !== ChatEntityType.CHAT ||
      !initialContext.settings.antiDuplicateEnabled ||
      !initialContext.settings.duplicatePhotoEnabled
    ) {
      return;
    }

    const flow = resolveDuplicateFlowConfig(initialContext.settings);
    if (Date.now() - album.createdAtMs > flow.windowSec * 1_000) {
      return;
    }
    const initialActionFence = await this.resolveMessageActionFence({
      chatId: album.chatId,
      userId: album.senderId,
      messageId: album.messageId,
    });

    const initialAdminCheck = await this.resolveAdminCheck({
      chatId: album.chatId,
      userId: album.senderId,
      localAdminUserIds: initialContext.adminUserIds,
    });
    if (initialAdminCheck?.isAdmin) {
      return;
    }

    const initialPolicy = resolvePhotoDuplicateRuntimePolicy({
      chatId: album.chatId,
      preset: initialContext.settings.duplicatePhotoMatchPreset,
      scope: initialContext.settings.duplicatePhotoScope,
      configService: this.configService,
    });
    if (initialPolicy.mode === 'off') {
      return;
    }
    const latestManualReleaseAt = await this.resolveLatestManualReleaseCreatedAt(
      album.chatId,
      album.senderId,
    );
    const releaseSuppressesEnforcement = Boolean(
      latestManualReleaseAt && isWithinWindow(latestManualReleaseAt, flow.windowSec),
    );
    const actionEligible: boolean =
      jobActionEligible &&
      initialPolicy.enforce &&
      !initialActionFence.blocked &&
      initialAdminCheck !== null &&
      initialAdminCheck.source !== 'local_fallback' &&
      !releaseSuppressesEnforcement;

    lease.assertOwned();
    const analysis = await this.analysisService.analyzeAlbum({
      album,
      ttlSeconds: flow.windowSec + 1,
      scope: initialContext.settings.duplicatePhotoScope,
      preset: initialContext.settings.duplicatePhotoMatchPreset,
      commitViolation: actionEligible,
      resolveActionEligibility: lease.resolveActionEligibility,
    });
    lease.assertOwned();
    if (analysis.kind !== 'observed' || analysis.observation.kind !== 'available') {
      return;
    }

    const observation = analysis.observation;
    const observationLog = {
      chatId: album.chatId,
      messageId: album.messageId,
      classification: observation.classification,
      matchKind: observation.matchKind,
      imageCount: analysis.imageCount,
      repeatCount: observation.repeatCount,
      rolloutMode: initialPolicy.mode,
      enforce: analysis.actionEligible,
    };
    if (observation.classification === 'duplicate') {
      this.logger.log(observationLog, 'Photo duplicate match observed');
    } else {
      this.logger.debug(observationLog, 'Photo duplicate analysis completed');
    }
    if (observation.classification !== 'duplicate' || observation.repeatCount <= 0) {
      return;
    }
    if (!analysis.actionEligible) {
      return;
    }

    const actionContext = await this.loadJobContext(album.chatId);
    if (
      !actionContext ||
      actionContext.entityType !== ChatEntityType.CHAT ||
      !actionContext.settings.antiDuplicateEnabled ||
      !actionContext.settings.duplicatePhotoEnabled ||
      actionContext.settings.duplicatePhotoMatchPreset !==
        initialContext.settings.duplicatePhotoMatchPreset ||
      actionContext.settings.duplicatePhotoScope !== initialContext.settings.duplicatePhotoScope
    ) {
      return;
    }

    const actionPolicy = resolvePhotoDuplicateRuntimePolicy({
      chatId: album.chatId,
      preset: actionContext.settings.duplicatePhotoMatchPreset,
      scope: actionContext.settings.duplicatePhotoScope,
      configService: this.configService,
    });
    if (!actionPolicy.enforce) {
      return;
    }
    const actionFlow = resolveDuplicateFlowConfig(actionContext.settings);
    if (!duplicateFlowConfigsEqual(flow, actionFlow)) {
      return;
    }

    const fingerprintType = analysis.imageCount === 1 ? 'image' : 'image_set';
    const provisionalOutcome = resolveDuplicateFlowOutcome({
      settings: actionContext.settings,
      repeatCount: observation.repeatCount,
      hash: observation.clusterId.slice(0, 20),
      fingerprintType,
    });
    if (!provisionalOutcome.hit) {
      return;
    }
    const intendedAction: PhotoDuplicateIntendedAction =
      provisionalOutcome.decision && actionPolicy.mode === 'full'
        ? provisionalOutcome.decision.action
        : 'HIT';
    const actionBinding = buildPhotoDuplicateActionBinding({
      settings: actionContext.settings,
      flow: actionFlow,
      rolloutMode: actionPolicy.mode,
      intendedAction,
      rulesPublishedUrl: actionContext.rulesPublishedUrl,
      rulesPublishedMessageId: actionContext.rulesPublishedMessageId,
    });
    const actionFence = await this.resolveMessageActionFence({
      chatId: album.chatId,
      userId: album.senderId,
      messageId: album.messageId,
      expectedBinding: actionBinding,
    });
    if (actionFence.blocked) {
      return;
    }

    const actionAdminCheck = await this.resolveFreshAdminCheck({
      chatId: album.chatId,
      userId: album.senderId,
      localAdminUserIds: actionContext.adminUserIds,
    });
    if (actionAdminCheck !== 'non_admin') {
      return;
    }
    const actionManualReleaseAt = await this.resolveLatestManualReleaseCreatedAt(
      album.chatId,
      album.senderId,
    );
    if (actionManualReleaseAt && isWithinWindow(actionManualReleaseAt, actionFlow.windowSec)) {
      return;
    }

    const duplicateMetadata = {
      duplicateSource: 'photo',
      fingerprintType,
      albumSize: analysis.imageCount,
      matchKind: observation.matchKind,
      distance: observation.matchedDistance,
      preset: actionContext.settings.duplicatePhotoMatchPreset,
      scope: actionContext.settings.duplicatePhotoScope,
      algorithmVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
      rolloutMode: actionPolicy.mode,
      photoDuplicateActionBindingVersion: PHOTO_DUPLICATE_ACTION_BINDING_VERSION,
      photoDuplicateIntendedAction: actionBinding.intendedAction,
      photoDuplicateFlowConfigDigest: actionBinding.configDigest,
    } satisfies Record<string, unknown>;
    const outcome = resolveDuplicateFlowOutcome({
      settings: actionContext.settings,
      repeatCount: observation.repeatCount,
      hash: observation.clusterId.slice(0, 20),
      fingerprintType,
      metadata: duplicateMetadata,
    });
    if (!outcome.hit) {
      return;
    }

    if (!(await lease.resolveActionEligibility())) {
      return;
    }
    lease.assertOwned();
    if (
      await this.actions.consumePhotoDuplicateParticipantImmunity({
        chatId: album.chatId,
        userId: album.senderId,
        nightModeTimezone: actionContext.settings.nightModeTimezone,
      })
    ) {
      return;
    }
    lease.assertOwned();

    const finalManualReleaseAt = await this.resolveLatestManualReleaseCreatedAt(
      album.chatId,
      album.senderId,
    );
    if (finalManualReleaseAt && isWithinWindow(finalManualReleaseAt, actionFlow.windowSec)) {
      return;
    }

    if (!(await lease.resolveActionEligibility())) {
      return;
    }
    lease.assertOwned();
    await this.actions.executePhotoDuplicateAction({
      update,
      chatId: album.chatId,
      userId: album.senderId,
      messageId: album.messageId,
      settings: actionContext.settings,
      rulesPublishedUrl: actionContext.rulesPublishedUrl,
      rulesPublishedMessageId: actionContext.rulesPublishedMessageId,
      actionClaimed: actionFence.actionClaimed,
      lease,
      outcome:
        outcome.decision && actionPolicy.mode === 'full'
          ? { kind: 'decision', decision: outcome.decision }
          : { kind: 'hit', hit: outcome.hit },
    });
    lease.assertOwned();
  }

  private async loadJobContext(chatId: string): Promise<PhotoDuplicateJobContext | null> {
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        entityType: true,
        settings: true,
        admins: { select: { userId: true } },
        rules: { select: { publishedUrl: true, publishedMessageId: true } },
      },
    });
    if (!chat?.settings) {
      return null;
    }
    return {
      entityType: chat.entityType,
      settings: chat.settings,
      adminUserIds: chat.admins.map((admin) => admin.userId),
      rulesPublishedUrl: chat.rules?.publishedUrl ?? null,
      rulesPublishedMessageId: chat.rules?.publishedMessageId ?? null,
    };
  }

  private async resolveAdminCheck(params: {
    chatId: string;
    userId: string;
    localAdminUserIds: string[];
  }): Promise<ChatAdminCheckResult | null> {
    try {
      return await this.moderationAccessService.resolveSenderChatAdminCheck(
        params.chatId,
        params.localAdminUserIds,
        params.userId,
        {
          allowRemoteLookup: true,
          skipRemoteLookupWhenLocalAdminsKnown: false,
        },
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: params.chatId,
          userId: params.userId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Photo duplicate admin check failed; enforcement remains fail-open',
      );
      return null;
    }
  }

  private async resolveFreshAdminCheck(params: {
    chatId: string;
    userId: string;
    localAdminUserIds: string[];
  }): Promise<'admin' | 'non_admin' | 'unknown'> {
    if (params.localAdminUserIds.includes(params.userId)) {
      return 'admin';
    }
    try {
      const access = await this.maxClient.getChatMemberAccess(params.chatId, params.userId, {
        bypassCache: true,
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.PHOTO_DUPLICATE_ADMIN_CHECK,
        timeoutMs: DEFAULT_CHAT_ADMIN_LOOKUP_TIMEOUT_MS,
      });
      if (!access) {
        return 'unknown';
      }
      return access.isAdmin || access.isOwner ? 'admin' : 'non_admin';
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: params.chatId,
          userId: params.userId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Fresh photo duplicate admin check failed; enforcement remains fail-open',
      );
      return 'unknown';
    }
  }

  private async resolveMessageActionFence(params: {
    chatId: string;
    userId: string;
    messageId: string;
    expectedBinding?: PhotoDuplicateActionBinding;
  }): Promise<PhotoDuplicateMessageActionFence> {
    try {
      const [deleteIntent, moderationEvents, messageActionClaims] = await Promise.all([
        this.prisma.moderationDeleteIntent.findUnique({
          where: {
            chatId_messageId: {
              chatId: params.chatId,
              messageId: params.messageId,
            },
          },
          select: {
            subjectUserId: true,
            reasons: {
              select: {
                userId: true,
                ruleCode: true,
                metadata: true,
              },
            },
          },
        }),
        this.prisma.moderationEvent.findMany({
          where: { chatId: params.chatId, messageId: params.messageId },
          select: {
            userId: true,
            ruleCode: true,
            metadata: true,
          },
        }),
        this.prisma.moderationViolationMessageClaim.findMany({
          where: {
            chatId: params.chatId,
            messageId: params.messageId,
            updateType: 'message_action',
          },
          select: {
            userId: true,
            ruleCode: true,
          },
        }),
      ]);

      const ownPhotoReasons =
        deleteIntent?.reasons.filter(
          (reason) =>
            reason.userId === params.userId &&
            reason.ruleCode === 'DUPLICATE_DELETE' &&
            readString(asRecord(reason.metadata)?.duplicateSource) === 'photo',
        ) ?? [];
      const ownPhotoDeleteIntent = Boolean(
        deleteIntent &&
        deleteIntent.subjectUserId === params.userId &&
        ownPhotoReasons.length === 1,
      );
      const persistedBinding = ownPhotoDeleteIntent
        ? readPhotoDuplicateActionBinding(ownPhotoReasons[0]?.metadata)
        : null;
      const hasForeignDeleteReason = Boolean(
        deleteIntent?.reasons.some(
          (reason) =>
            reason.userId !== params.userId ||
            reason.ruleCode !== 'DUPLICATE_DELETE' ||
            readString(asRecord(reason.metadata)?.duplicateSource) !== 'photo',
        ),
      );
      const ownPhotoEvents = moderationEvents.filter(
        (event) =>
          event.userId === params.userId &&
          readString(asRecord(event.metadata)?.duplicateSource) === 'photo',
      );
      const hasCompletedPhotoFollowUp = ownPhotoEvents.some((event) =>
        ['DUPLICATE_WARN', 'DUPLICATE_MUTE', 'DUPLICATE_BAN'].includes(event.ruleCode),
      );
      const hasUnexpectedOwnPhotoEvent = ownPhotoEvents.some(
        (event) =>
          event.ruleCode !== 'DUPLICATE_DELETE' &&
          !['DUPLICATE_WARN', 'DUPLICATE_MUTE', 'DUPLICATE_BAN'].includes(event.ruleCode),
      );
      const hasForeignEvent = moderationEvents.some((event) => !ownPhotoEvents.includes(event));
      const ownActionClaims = messageActionClaims.filter(
        (claim) =>
          claim.userId === params.userId &&
          claim.ruleCode === DUPLICATE_MESSAGE_ACTION_CLAIM_RULE_CODE,
      );
      const hasForeignClaim = messageActionClaims.length !== ownActionClaims.length;
      const bindingMismatch = Boolean(
        params.expectedBinding &&
        persistedBinding &&
        !photoDuplicateActionBindingsEqual(params.expectedBinding, persistedBinding),
      );

      if (
        hasCompletedPhotoFollowUp ||
        hasUnexpectedOwnPhotoEvent ||
        hasForeignDeleteReason ||
        hasForeignEvent ||
        hasForeignClaim ||
        (deleteIntent !== null && !ownPhotoDeleteIntent) ||
        (ownPhotoDeleteIntent && !persistedBinding) ||
        (ownActionClaims.length > 0 && !ownPhotoDeleteIntent) ||
        bindingMismatch
      ) {
        return { blocked: true, actionClaimed: false, persistedBinding: null };
      }

      return {
        blocked: false,
        actionClaimed: ownActionClaims.length > 0,
        persistedBinding,
      };
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: params.chatId,
          messageId: params.messageId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Photo duplicate action fence unavailable; enforcement remains fail-open',
      );
      return { blocked: true, actionClaimed: false, persistedBinding: null };
    }
  }

  private async resolveLatestManualReleaseCreatedAt(
    chatId: string,
    userId: string,
  ): Promise<Date | null> {
    const latestManualRelease = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId,
        userId,
        ruleCode: { in: ['MANUAL_UNMUTE', 'MANUAL_UNBAN'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return latestManualRelease?.createdAt ?? null;
  }
}

export function buildPhotoDuplicateActionBinding(params: {
  settings: ChatSettings;
  flow: DuplicateFlowConfig;
  rolloutMode: PhotoDuplicateRolloutMode;
  intendedAction: PhotoDuplicateIntendedAction;
  rulesPublishedUrl: string | null;
  rulesPublishedMessageId: string | null;
}): PhotoDuplicateActionBinding {
  const config = {
    version: PHOTO_DUPLICATE_ACTION_BINDING_VERSION,
    intendedAction: params.intendedAction,
    rolloutMode: params.rolloutMode,
    preset: params.settings.duplicatePhotoMatchPreset,
    scope: params.settings.duplicatePhotoScope,
    flow: {
      allowedCount: params.flow.allowedCount,
      windowSec: params.flow.windowSec,
      reactions: params.flow.reactions.map((stage) => stage.action),
    },
    action: {
      muteDurationHours: params.settings.duplicateMuteDurationHours,
      botSpeechStyle: params.settings.botSpeechStyle,
      botSpeechMedia: params.settings.botSpeechMedia,
      duplicateBotMessageEnabled: params.settings.duplicateBotMessageEnabled,
      duplicateBotMessageText: params.settings.duplicateBotMessageText,
      duplicateBotButtons: params.settings.duplicateBotButtons,
      duplicateBotButtonEnabled: params.settings.duplicateBotButtonEnabled,
      duplicateBotButtonUrl: params.settings.duplicateBotButtonUrl,
      duplicateBotButtonText: params.settings.duplicateBotButtonText,
      duplicateAdminContactButtonEnabled: params.settings.duplicateAdminContactButtonEnabled,
      duplicateAdminContactButtonUrl: params.settings.duplicateAdminContactButtonUrl,
      rulesAttachViolationsEnabled: params.settings.rulesAttachViolationsEnabled,
      rulesPublishedUrl: params.rulesPublishedUrl,
      rulesPublishedMessageId: params.rulesPublishedMessageId,
      deleteBotMessagesEnabled: params.settings.deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes: params.settings.deleteBotMessagesDelayMinutes,
    },
  };
  return {
    intendedAction: params.intendedAction,
    configDigest: createHash('sha256').update(canonicalJson(config)).digest('hex'),
  };
}

function readPhotoDuplicateActionBinding(value: unknown): PhotoDuplicateActionBinding | null {
  const metadata = asRecord(value);
  if (metadata?.photoDuplicateActionBindingVersion !== PHOTO_DUPLICATE_ACTION_BINDING_VERSION) {
    return null;
  }
  const intendedAction = readString(metadata.photoDuplicateIntendedAction);
  const configDigest = readString(metadata.photoDuplicateFlowConfigDigest);
  if (
    !intendedAction ||
    !['HIT', 'WARN', 'MUTE', 'BAN'].includes(intendedAction) ||
    !configDigest ||
    !/^[a-f0-9]{64}$/u.test(configDigest)
  ) {
    return null;
  }
  return {
    intendedAction: intendedAction as PhotoDuplicateIntendedAction,
    configDigest,
  };
}

function photoDuplicateActionBindingsEqual(
  left: PhotoDuplicateActionBinding,
  right: PhotoDuplicateActionBinding,
): boolean {
  return left.intendedAction === right.intendedAction && left.configDigest === right.configDigest;
}

function isWithinWindow(createdAt: Date, windowSec: number): boolean {
  return Date.now() - createdAt.getTime() <= Math.max(1, windowSec) * 1_000;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(',')}}`;
  }
  return 'null';
}
