import type { MaxUpdate } from '@maxim/contracts';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

import { isPrivateDirectChatId } from '../../common/chat-id.util';
import { MaxBotContextService } from '../../max/max-bot-context.service';
import { MaxBotLinkService } from '../../max/max-bot-link.service';
import { MaxClientService } from '../../max/max-client.service';
import { ChatEntityType, WebhookStatus, type ChatSettings } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { BackgroundRuntimeGovernorService } from '../../system/background-runtime-governor.service';
import {
  buildMessageScopedModerationActionClaimKey,
  claimDurableModerationMessageAction,
  type ModerationMessageActionClaimModel,
} from '../moderation-message-action-claim';
import { ModerationDeleteIntentService } from '../moderation-delete-intent.service';
import { ParticipantModerationImmunityService } from '../participant-moderation-immunity.service';
import {
  extractLogicalPhotoAlbumResult,
  type LogicalPhotoAlbum,
} from '../photo-duplicate/photo-attachment-extractor';
import { CommercialOcrAdmissionStore } from './commercial-ocr-admission.store';
import {
  CommercialOcrAnalysisService,
  type CommercialOcrAnalysisRetryReason,
} from './commercial-ocr-analysis.service';
import {
  buildCommercialOcrDeleteBinding,
  COMMERCIAL_OCR_DELETE_RULE_CODE,
  COMMERCIAL_OCR_PARTICIPANT_IMMUNITY_SCOPE,
  extractCommercialOcrDeleteSource,
  type CommercialOcrDeleteBinding,
  type CommercialOcrDeleteSource,
} from './commercial-ocr-delete-guard.service';
import { COMMERCIAL_OCR_JOB_SCHEMA_VERSION, type CommercialOcrJob } from './commercial-ocr.queue';
import { resolveCommercialOcrRuntimePolicy } from './commercial-ocr.runtime';

const GOVERNOR_COMPONENT = 'commercial-image-ocr';
const GOVERNOR_SOURCE_TAG = 'commercial_image_ocr';
const ADMIN_LOOKUP_TIMEOUT_MS = 3_000;
const MESSAGE_ACTION_CLAIM_RULE_CODE = 'COMMERCIAL_OCR_MESSAGE_ACTION';

export type CommercialOcrJobProcessResult =
  | { kind: 'completed' }
  | { kind: 'retry'; reason: CommercialOcrAnalysisRetryReason }
  | {
      kind: 'defer';
      delayMs: number;
      reason: 'source_not_ready' | 'governor_pressure' | 'singleflight_busy' | 'admission_pending';
    };

type CommercialOcrJobContext = {
  entityType: ChatEntityType;
  settings: ChatSettings;
  localAdminUserIds: string[];
};

type SourceEnvelope = {
  update: MaxUpdate;
  album: LogicalPhotoAlbum;
  originBotId: string;
  exactSource: CommercialOcrDeleteSource;
};

@Injectable()
export class CommercialOcrModerationService {
  private readonly logger = new Logger(CommercialOcrModerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly analysisService: CommercialOcrAnalysisService,
    private readonly admissionStore: CommercialOcrAdmissionStore,
    private readonly governor: BackgroundRuntimeGovernorService,
    private readonly maxClient: MaxClientService,
    private readonly maxBotContextService: MaxBotContextService,
    private readonly maxBotLinkService: MaxBotLinkService,
    private readonly participantImmunity: ParticipantModerationImmunityService,
    private readonly moderationDeleteIntents: ModerationDeleteIntentService,
    private readonly configService: ConfigService,
  ) {}

  async processCommercialOcrJob(
    job: CommercialOcrJob,
    jobId: string,
  ): Promise<CommercialOcrJobProcessResult> {
    if (job.schemaVersion !== COMMERCIAL_OCR_JOB_SCHEMA_VERSION) {
      return { kind: 'completed' };
    }

    const initialAdmission = await this.admissionStore.resolveState(jobId);
    if (initialAdmission.kind !== 'available' || initialAdmission.state === 'pending') {
      return initialAdmission.kind === 'available'
        ? { kind: 'defer', delayMs: 5_000, reason: 'admission_pending' }
        : { kind: 'completed' };
    }
    const runtime = resolveCommercialOcrRuntimePolicy({
      chatId: job.chatId,
      configService: this.configService,
    });
    if (!runtime.process) {
      return { kind: 'completed' };
    }

    const source = await this.loadSource(job);
    if (source.kind !== 'ready') {
      return source.kind === 'defer'
        ? { kind: 'defer', delayMs: source.delayMs, reason: 'source_not_ready' }
        : { kind: 'completed' };
    }

    const execute = () =>
      this.processReadySource(job, jobId, source.value, initialAdmission.state === 'actionable');
    return this.maxBotContextService.runWithBot(source.value.originBotId, execute);
  }

  private async processReadySource(
    job: CommercialOcrJob,
    jobId: string,
    source: SourceEnvelope,
    admissionActionEligible: boolean,
  ): Promise<CommercialOcrJobProcessResult> {
    if (
      isPrivateDirectChatId(source.album.chatId) ||
      this.maxBotLinkService.isKnownBotUserId(source.album.senderId) ||
      isBotOrServiceAuthored(source.update)
    ) {
      return { kind: 'completed' };
    }

    const context = await this.loadJobContext(job.chatId);
    if (
      !context ||
      context.entityType !== ChatEntityType.CHAT ||
      !context.settings.commercialAdsFilterEnabled ||
      context.localAdminUserIds.includes(source.album.senderId)
    ) {
      return { kind: 'completed' };
    }
    if (!(await this.isFreshNonAdmin(job.chatId, source.album.senderId, source.originBotId))) {
      return { kind: 'completed' };
    }

    const analysis = await this.analysisService.analyzeAlbum({
      album: source.album,
      caption: source.exactSource.caption,
      settings: context.settings,
      ocrVersion: job.ocrVersion,
      authorizeStage: () => this.authorizeHeavyStage(),
    });
    if (analysis.kind === 'defer') {
      return {
        kind: 'defer',
        delayMs: analysis.delayMs,
        reason: analysis.reason,
      };
    }
    if (analysis.kind === 'retry') {
      return { kind: 'retry', reason: analysis.reason };
    }
    if (analysis.kind !== 'complete') {
      this.logger.log(
        {
          chatId: job.chatId,
          messageId: job.messageId,
          imageCount: job.imageCount,
          rolloutMode: resolveCommercialOcrRuntimePolicy({
            chatId: job.chatId,
            configService: this.configService,
          }).mode,
          outcome: 'INCOMPLETE',
          reason: analysis.reason,
          ...(analysis.imageIndex === undefined ? {} : { imageIndex: analysis.imageIndex }),
          ...(analysis.pass === undefined ? {} : { pass: analysis.pass }),
        },
        'Commercial OCR analysis incomplete',
      );
      return { kind: 'completed' };
    }

    this.logger.log(
      {
        chatId: job.chatId,
        messageId: job.messageId,
        imageCount: job.imageCount,
        rolloutMode: resolveCommercialOcrRuntimePolicy({
          chatId: job.chatId,
          configService: this.configService,
        }).mode,
        action: analysis.decision.action,
        reasonCodes: analysis.decision.reasonCodes,
      },
      'Commercial OCR decision completed',
    );
    if (analysis.decision.action !== 'DELETE' || !admissionActionEligible) {
      return { kind: 'completed' };
    }

    const authorization = await this.resolveFinalAuthorization({
      job,
      jobId,
      initialContext: context,
      initialSource: source,
    });
    if (!authorization) {
      return { kind: 'completed' };
    }

    if (
      await this.consumeParticipantImmunityFailOpen({
        chatId: job.chatId,
        userId: authorization.exactSource.senderId,
        messageId: job.messageId,
        nightModeTimezone: authorization.context.settings.nightModeTimezone,
      })
    ) {
      return { kind: 'completed' };
    }

    const binding = buildCommercialOcrDeleteBinding({
      ocrVersion: job.ocrVersion,
      senderId: authorization.exactSource.senderId,
      orderedPhotoIds: authorization.exactSource.orderedPhotoIds,
      caption: authorization.exactSource.caption,
      sourceCreatedAt: authorization.exactSource.sourceCreatedAt,
      expectedImageCount: job.imageCount,
      settings: authorization.context.settings,
    });
    const claim = await this.claimMessageAction({
      chatId: job.chatId,
      messageId: job.messageId,
      userId: authorization.exactSource.senderId,
      binding,
    });
    if (claim === 'blocked') {
      return { kind: 'completed' };
    }

    await this.moderationDeleteIntents.ensureIntent({
      chatId: job.chatId,
      messageId: job.messageId,
      reasonKey: `commercial-ocr-delete:${jobId}`,
      ruleCode: COMMERCIAL_OCR_DELETE_RULE_CODE,
      subjectUserId: authorization.exactSource.senderId,
      sourceMessageAt: authorization.exactSource.sourceCreatedAt,
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      originBotId: authorization.originBotId,
      routingPolicy: 'delete_capable',
      event: {
        userId: authorization.exactSource.senderId,
        eventType: 'MESSAGE',
        score: 1,
        metadata: { commercialOcrBinding: binding },
      },
    });
    return { kind: 'completed' };
  }

  private async loadSource(
    job: CommercialOcrJob,
  ): Promise<
    | { kind: 'ready'; value: SourceEnvelope }
    | { kind: 'defer'; delayMs: number }
    | { kind: 'terminal' }
  > {
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
    if (
      !webhookEvent ||
      webhookEvent.status === WebhookStatus.DUPLICATE ||
      (webhookEvent.status === WebhookStatus.FAILED && webhookEvent.nextEnqueueAt === null)
    ) {
      return { kind: 'terminal' };
    }
    if (webhookEvent.status !== WebhookStatus.PROCESSED) {
      return { kind: 'defer', delayMs: 5_000 };
    }

    const update = webhookEvent.normalizedPayload as MaxUpdate;
    const extraction = extractLogicalPhotoAlbumResult(update);
    if (extraction.kind !== 'complete') {
      return { kind: 'terminal' };
    }
    const album = extraction.album;
    if (
      album.chatId !== job.chatId ||
      album.messageId !== job.messageId ||
      album.createdAtMs !== Date.parse(job.sourceCreatedAt) ||
      album.images.length !== job.imageCount
    ) {
      this.logger.warn(
        { webhookEventId: job.webhookEventId, jobId: job.idempotencyKey },
        'Skipped commercial OCR job whose source identity does not match the webhook',
      );
      return { kind: 'terminal' };
    }

    const updateRecord = update as unknown as Record<string, unknown>;
    const originBotId =
      readString(webhookEvent.executionClaims[0]?.executionBotId) ??
      readString(webhookEvent.botId) ??
      readString(updateRecord.executionOwnerBotId) ??
      readString(update.botId) ??
      this.maxBotLinkService.getDefaultBotId();
    const exact = await this.loadExactSource(job, originBotId);
    if (!exact || !sameAlbumSource(album, exact, job)) {
      return { kind: 'terminal' };
    }
    return { kind: 'ready', value: { update, album, originBotId, exactSource: exact } };
  }

  private async loadExactSource(
    job: CommercialOcrJob,
    botId: string,
  ): Promise<CommercialOcrDeleteSource | null> {
    try {
      const row = await this.maxClient.getExactMessageRow(job.chatId, job.messageId, {
        trafficClass: 'background',
        sourceTag: GOVERNOR_SOURCE_TAG,
        botId,
        bypassCache: true,
      });
      return row ? extractCommercialOcrDeleteSource(row) : null;
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: job.chatId,
          messageId: job.messageId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Commercial OCR exact source lookup failed; enforcement remains fail-open',
      );
      return null;
    }
  }

  private async resolveFinalAuthorization(params: {
    job: CommercialOcrJob;
    jobId: string;
    initialContext: CommercialOcrJobContext;
    initialSource: SourceEnvelope;
  }): Promise<{
    context: CommercialOcrJobContext;
    exactSource: CommercialOcrDeleteSource;
    originBotId: string;
  } | null> {
    const admission = await this.admissionStore.resolveState(params.jobId);
    if (admission.kind !== 'available' || admission.state !== 'actionable') {
      return null;
    }
    const runtime = resolveCommercialOcrRuntimePolicy({
      chatId: params.job.chatId,
      configService: this.configService,
    });
    if (
      !runtime.enforce ||
      this.moderationDeleteIntents.getRolloutForRule(
        params.job.chatId,
        COMMERCIAL_OCR_DELETE_RULE_CODE,
      ) !== 'execute'
    ) {
      return null;
    }

    const context = await this.loadJobContext(params.job.chatId);
    if (
      !context ||
      context.entityType !== ChatEntityType.CHAT ||
      !context.settings.commercialAdsFilterEnabled ||
      !sameCommercialPolicy(context.settings, params.initialContext.settings) ||
      context.localAdminUserIds.includes(params.initialSource.album.senderId)
    ) {
      return null;
    }
    if (
      !(await this.isFreshNonAdmin(
        params.job.chatId,
        params.initialSource.album.senderId,
        params.initialSource.originBotId,
      ))
    ) {
      return null;
    }

    const exactSource = await this.loadExactSource(params.job, params.initialSource.originBotId);
    if (
      !exactSource ||
      !sameAlbumSource(params.initialSource.album, exactSource, params.job) ||
      !sameExactSource(exactSource, params.initialSource.exactSource)
    ) {
      return null;
    }

    const finalAdmission = await this.admissionStore.resolveState(params.jobId);
    if (finalAdmission.kind !== 'available' || finalAdmission.state !== 'actionable') {
      return null;
    }
    const finalRuntime = resolveCommercialOcrRuntimePolicy({
      chatId: params.job.chatId,
      configService: this.configService,
    });
    if (!finalRuntime.enforce) {
      return null;
    }
    return { context, exactSource, originBotId: params.initialSource.originBotId };
  }

  private async loadJobContext(chatId: string): Promise<CommercialOcrJobContext | null> {
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        entityType: true,
        settings: true,
        admins: { select: { userId: true } },
      },
    });
    if (!chat?.settings) {
      return null;
    }
    return {
      entityType: chat.entityType,
      settings: chat.settings,
      localAdminUserIds: chat.admins.map((admin) => admin.userId),
    };
  }

  private async isFreshNonAdmin(chatId: string, userId: string, botId: string): Promise<boolean> {
    try {
      const access = await this.maxClient.getChatMemberAccess(chatId, userId, {
        trafficClass: 'background',
        sourceTag: GOVERNOR_SOURCE_TAG,
        botId,
        bypassCache: true,
        timeoutMs: ADMIN_LOOKUP_TIMEOUT_MS,
      });
      return Boolean(
        access &&
        (access.userId === null || access.userId === userId) &&
        !access.isAdmin &&
        !access.isOwner,
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Commercial OCR fresh admin check failed; enforcement remains fail-open',
      );
      return false;
    }
  }

  private async authorizeHeavyStage(): Promise<boolean> {
    try {
      const decision = await this.governor.decide({
        component: GOVERNOR_COMPONENT,
        sourceTag: GOVERNOR_SOURCE_TAG,
      });
      return decision.action === 'run';
    } catch {
      return false;
    }
  }

  private async consumeParticipantImmunityFailOpen(params: {
    chatId: string;
    userId: string;
    messageId: string;
    nightModeTimezone: string | null;
  }): Promise<boolean> {
    try {
      return (
        (await this.participantImmunity.consumeForMessage({
          ...params,
          scope: COMMERCIAL_OCR_PARTICIPANT_IMMUNITY_SCOPE,
        })) === 'granted'
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: params.chatId,
          userId: params.userId,
          messageId: params.messageId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Commercial OCR participant immunity check failed; enforcement remains fail-open',
      );
      return true;
    }
  }

  private async claimMessageAction(params: {
    chatId: string;
    messageId: string;
    userId: string;
    binding: CommercialOcrDeleteBinding;
  }): Promise<'claimed' | 'resumed' | 'blocked'> {
    const bindingDigest = createHash('sha256').update(JSON.stringify(params.binding)).digest('hex');
    try {
      return await claimDurableModerationMessageAction({
        model: this.prisma
          .moderationViolationMessageClaim as unknown as ModerationMessageActionClaimModel,
        data: {
          dedupeKey: `commercial-ocr-action:v1:${bindingDigest}`,
          messageActionKey: buildMessageScopedModerationActionClaimKey(
            params.chatId,
            params.messageId,
          ),
          chatId: params.chatId,
          userId: params.userId,
          messageId: params.messageId,
          ruleCode: MESSAGE_ACTION_CLAIM_RULE_CODE,
          updateType: 'message_action',
        },
        resumeKnownOwner: true,
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: params.chatId,
          messageId: params.messageId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to establish durable commercial OCR action ownership',
      );
      return 'blocked';
    }
  }
}

function sameAlbumSource(
  album: LogicalPhotoAlbum,
  source: CommercialOcrDeleteSource,
  job: CommercialOcrJob,
): boolean {
  const photoIds = album.images.map((image) => image.photoId);
  return (
    source.chatId === job.chatId &&
    source.messageId === job.messageId &&
    source.senderId === album.senderId &&
    source.sourceCreatedAt === new Date(album.createdAtMs).toISOString() &&
    source.sourceCreatedAt === new Date(job.sourceCreatedAt).toISOString() &&
    source.orderedPhotoIds.length === job.imageCount &&
    photoIds.length === source.orderedPhotoIds.length &&
    photoIds.every(
      (photoId, index) => photoId !== null && photoId === source.orderedPhotoIds[index],
    )
  );
}

function sameExactSource(
  left: CommercialOcrDeleteSource,
  right: CommercialOcrDeleteSource,
): boolean {
  return (
    left.chatId === right.chatId &&
    left.messageId === right.messageId &&
    left.senderId === right.senderId &&
    left.sourceCreatedAt === right.sourceCreatedAt &&
    left.caption === right.caption &&
    left.orderedPhotoIds.length === right.orderedPhotoIds.length &&
    left.orderedPhotoIds.every((photoId, index) => photoId === right.orderedPhotoIds[index])
  );
}

function sameCommercialPolicy(left: ChatSettings, right: ChatSettings): boolean {
  return (
    left.commercialAdsFilterEnabled === right.commercialAdsFilterEnabled &&
    left.commercialAdsSensitivity === right.commercialAdsSensitivity &&
    left.commercialAdsWarnThreshold === right.commercialAdsWarnThreshold &&
    left.commercialAdsDeleteThreshold === right.commercialAdsDeleteThreshold
  );
}

function isBotOrServiceAuthored(update: MaxUpdate): boolean {
  const raw = asRecord(update.raw);
  const message = raw ? selectRawMessage(raw) : null;
  for (const sender of [
    asRecord(message?.sender),
    asRecord(message?.from),
    asRecord(raw?.sender),
    asRecord(raw?.from),
  ]) {
    if (!sender) continue;
    const type = readString(sender.type)?.toLowerCase() ?? readString(sender.kind)?.toLowerCase();
    if (
      type === 'bot' ||
      type === 'service' ||
      sender.is_bot === true ||
      sender.isBot === true ||
      sender.bot === true ||
      sender.is_service === true ||
      sender.isService === true
    ) {
      return true;
    }
  }
  return false;
}

function selectRawMessage(raw: Record<string, unknown>): Record<string, unknown> | null {
  const direct = asRecord(raw.message);
  if (direct) return direct;
  for (const key of ['message_created', 'data', 'event']) {
    const envelope = asRecord(raw[key]);
    const nested = asRecord(envelope?.message);
    if (nested) return nested;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim();
  return normalized || null;
}
