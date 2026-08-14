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
import { buildMessageScopedModerationActionClaimKey } from '../moderation-message-action-claim';
import { ModerationDeleteIntentService } from '../moderation-delete-intent.service';
import { ParticipantModerationImmunityService } from '../participant-moderation-immunity.service';
import {
  extractLogicalPhotoAlbumResult,
  type LogicalPhotoAlbum,
} from '../photo-duplicate/photo-attachment-extractor';
import { resolveCommercialOcrReservationTtlMs } from './commercial-ocr-admission.config';
import { CommercialOcrAdmissionStore } from './commercial-ocr-admission.store';
import {
  CommercialOcrAnalysisService,
  type CommercialOcrAnalysisRetryReason,
} from './commercial-ocr-analysis.service';
import { isCommercialOcrCyrillicOnlyDeleteDecision } from './commercial-ocr-decision-policy';
import {
  buildCommercialOcrDeleteBinding,
  COMMERCIAL_OCR_DELETE_RULE_CODE,
  COMMERCIAL_OCR_MESSAGE_ACTION_RULE_CODE,
  COMMERCIAL_OCR_PARTICIPANT_IMMUNITY_SCOPE,
  extractCommercialOcrExactMessageSource,
  type CommercialOcrDeleteBinding,
  type CommercialOcrDeleteSource,
  type CommercialOcrExactMessageSource,
} from './commercial-ocr-delete-guard.service';
import { COMMERCIAL_OCR_JOB_SCHEMA_VERSION, type CommercialOcrJob } from './commercial-ocr.queue';
import { CommercialOcrMetricsService } from './commercial-ocr-metrics.service';
import { CommercialOcrRuntimePolicyService } from './commercial-ocr-runtime-policy.service';
import { resolveCommercialOcrRuntimePolicy } from './commercial-ocr.runtime';
import { fingerprintCommercialOcrSettingsProfile } from './commercial-ocr-settings-profile';

const GOVERNOR_COMPONENT = 'commercial-image-ocr';
const GOVERNOR_SOURCE_TAG = 'commercial_image_ocr';
const ADMIN_LOOKUP_TIMEOUT_MS = 3_000;

export type CommercialOcrJobProcessResult =
  | { kind: 'completed' }
  | { kind: 'retry'; reason: CommercialOcrAnalysisRetryReason }
  | {
      kind: 'defer';
      delayMs: number;
      reason: 'source_not_ready' | 'governor_pressure' | 'admission_pending';
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
  persistedDownloadUrlFallbackIndexes: readonly number[];
};

@Injectable()
export class CommercialOcrModerationService {
  private readonly logger = new Logger(CommercialOcrModerationService.name);
  private readonly admissionTombstoneTtlMs: number;

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
    private readonly runtimePolicy: CommercialOcrRuntimePolicyService,
    private readonly configService: ConfigService,
    private readonly metrics: CommercialOcrMetricsService,
  ) {
    this.admissionTombstoneTtlMs = resolveCommercialOcrReservationTtlMs(configService);
  }

  async processCommercialOcrJob(
    job: CommercialOcrJob,
    jobId: string,
    deadlineAtMs: number,
  ): Promise<CommercialOcrJobProcessResult> {
    if (deadlineExpired(deadlineAtMs)) {
      return { kind: 'completed' };
    }
    if (job.schemaVersion !== COMMERCIAL_OCR_JOB_SCHEMA_VERSION) {
      return { kind: 'completed' };
    }

    const initialAdmission = await this.admissionStore.resolveState(jobId);
    if (initialAdmission.kind !== 'available') {
      return { kind: 'completed' };
    }
    const runtime = resolveCommercialOcrRuntimePolicy({
      chatId: job.chatId,
      configService: this.configService,
    });
    if (!runtime.process) {
      return { kind: 'completed' };
    }

    const source = await this.loadSource(job, deadlineAtMs);
    if (source.kind !== 'ready') {
      if (initialAdmission.state === 'pending' && source.kind === 'terminal') {
        await this.suppressPendingAdmission(job, jobId);
      }
      return source.kind === 'defer'
        ? { kind: 'defer', delayMs: source.delayMs, reason: 'source_not_ready' }
        : { kind: 'completed' };
    }

    let admissionActionEligible = initialAdmission.state === 'actionable';
    if (initialAdmission.state === 'pending') {
      admissionActionEligible = await this.reconcilePendingAdmission(job, jobId, deadlineAtMs);
      if (!admissionActionEligible) {
        return { kind: 'completed' };
      }
    }

    const execute = () =>
      this.processReadySource(job, jobId, source.value, admissionActionEligible, deadlineAtMs);
    return this.maxBotContextService.runWithBot(source.value.originBotId, execute);
  }

  private async reconcilePendingAdmission(
    job: CommercialOcrJob,
    jobId: string,
    deadlineAtMs: number,
  ): Promise<boolean> {
    if (deadlineExpired(deadlineAtMs)) {
      const suppression = await this.suppressPendingAdmission(job, jobId);
      this.metrics.recordCounter(
        suppression === 'suppressed'
          ? 'admission.reconciliation.suppressed'
          : 'admission.reconciliation.unavailable',
      );
      return false;
    }

    this.metrics.recordCounter('admission.reconciliation.attempted');
    const activation = await this.admissionStore
      .activate({ jobId, tombstoneTtlMs: this.admissionTombstoneTtlMs })
      .catch(() => 'unavailable' as const);

    if (activation === 'unavailable') {
      this.metrics.recordCounter('admission.reconciliation.unavailable');
      // The activation EVAL may commit after its local timeout. Suppression on the same store
      // connection is ordered after it and makes either outcome non-actionable.
      await this.suppressPendingAdmission(job, jobId);
      return false;
    }
    if (activation === 'suppressed' || activation === 'expired' || activation === 'missing') {
      this.metrics.recordCounter('admission.reconciliation.suppressed');
      return false;
    }

    // A webhook producer may win the race after the initial pending read. Both successful outcomes
    // confirm actionability without performing any transition other than pending -> actionable.
    this.metrics.recordCounter('admission.reconciliation.activated');
    if (!deadlineExpired(deadlineAtMs)) {
      return true;
    }

    const suppression = await this.suppressPendingAdmission(job, jobId);
    this.metrics.recordCounter(
      suppression === 'suppressed'
        ? 'admission.reconciliation.suppressed'
        : 'admission.reconciliation.unavailable',
    );
    return false;
  }

  private async suppressPendingAdmission(
    job: CommercialOcrJob,
    jobId: string,
  ): Promise<'suppressed' | 'unavailable'> {
    const suppression = await this.admissionStore
      .suppress({
        jobId,
        chatId: job.chatId,
        imageCount: job.imageCount,
        tombstoneTtlMs: this.admissionTombstoneTtlMs,
      })
      .catch(() => 'unavailable' as const);
    this.metrics.recordCounter(
      suppression === 'suppressed'
        ? 'admission.suppression.suppressed'
        : 'admission.suppression.unavailable',
    );
    return suppression;
  }

  private async processReadySource(
    job: CommercialOcrJob,
    jobId: string,
    source: SourceEnvelope,
    admissionActionEligible: boolean,
    deadlineAtMs: number,
  ): Promise<CommercialOcrJobProcessResult> {
    if (deadlineExpired(deadlineAtMs)) {
      return { kind: 'completed' };
    }
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
    const initialSettingsFingerprint = fingerprintSettingsFailOpen(context.settings);
    if (!initialSettingsFingerprint) {
      return { kind: 'completed' };
    }
    if (
      !(await this.isFreshNonAdmin(
        job.chatId,
        source.album.senderId,
        source.originBotId,
        deadlineAtMs,
      ))
    ) {
      return { kind: 'completed' };
    }

    const analysis = await this.analysisService.analyzeAlbum({
      album: source.album,
      caption: source.album.caption,
      settings: context.settings,
      ocrVersion: job.ocrVersion,
      deadlineAtMs,
      authorizeStage: () => this.authorizeHeavyStage(),
    });
    if (analysis.kind === 'defer') {
      this.metrics.recordCounter(`analysis.defer.${analysis.reason}`);
      return {
        kind: 'defer',
        delayMs: analysis.delayMs,
        reason: analysis.reason,
      };
    }
    if (analysis.kind === 'retry') {
      this.metrics.recordCounter(`analysis.retry.${analysis.reason}`);
      return { kind: 'retry', reason: analysis.reason };
    }
    if (
      analysis.kind === 'incomplete' &&
      analysis.reason === 'download_failed' &&
      analysis.imageIndex !== undefined &&
      source.persistedDownloadUrlFallbackIndexes.includes(analysis.imageIndex)
    ) {
      this.metrics.recordCounter('analysis.retry.download_failed');
      return { kind: 'retry', reason: 'download_failed' };
    }
    if (analysis.kind !== 'complete') {
      this.metrics.recordCounter(`analysis.incomplete.${analysis.reason}`);
      this.metrics.recordCounter(`analysis.incomplete.pass.${analysis.pass ?? 'none'}`);
      this.logger.log(
        {
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

    this.metrics.recordCounter(
      analysis.decision.action === 'DELETE'
        ? 'analysis.complete.delete'
        : 'analysis.complete.no_action',
    );

    this.logger.log(
      {
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
    if (analysis.decision.action !== 'DELETE') {
      return { kind: 'completed' };
    }
    if (source.persistedDownloadUrlFallbackIndexes.length > 0) {
      this.metrics.recordCounter('enforcement.suppressed.source_url_fallback');
      return { kind: 'completed' };
    }
    if (!admissionActionEligible) {
      this.metrics.recordCounter('enforcement.suppressed.admission');
      return { kind: 'completed' };
    }
    if (!isCommercialOcrCyrillicOnlyDeleteDecision(analysis.decision)) {
      this.metrics.recordCounter('enforcement.suppressed.script_guard');
      return { kind: 'completed' };
    }
    if (deadlineExpired(deadlineAtMs)) {
      this.metrics.recordCounter('enforcement.suppressed.deadline');
      return { kind: 'completed' };
    }

    // FLAG: The environment policy is only a processing ceiling. A fresh shared control must
    // authorize enforcement before the final MAX lookups and again immediately before commit.
    const actionRuntime = await this.runtimePolicy.resolveEffectivePolicy({
      chatId: job.chatId,
      settingsFingerprint: initialSettingsFingerprint,
    });
    if (!actionRuntime.enforce || deadlineExpired(deadlineAtMs)) {
      this.metrics.recordCounter(
        deadlineExpired(deadlineAtMs)
          ? 'enforcement.suppressed.deadline'
          : 'enforcement.suppressed.runtime_control',
      );
      return { kind: 'completed' };
    }

    const authorization = await this.resolveFinalAuthorization({
      job,
      jobId,
      initialContext: context,
      initialSource: source,
      deadlineAtMs,
    });
    if (!authorization) {
      this.metrics.recordCounter('enforcement.suppressed.authorization');
      return { kind: 'completed' };
    }

    const preImmunityRuntime = await this.runtimePolicy.resolveEffectivePolicy({
      chatId: job.chatId,
      settingsFingerprint: fingerprintCommercialOcrSettingsProfile(authorization.context.settings),
    });
    if (!preImmunityRuntime.enforce || deadlineExpired(deadlineAtMs)) {
      this.metrics.recordCounter(
        deadlineExpired(deadlineAtMs)
          ? 'enforcement.suppressed.deadline'
          : 'enforcement.suppressed.runtime_control',
      );
      return { kind: 'completed' };
    }

    if (deadlineExpired(deadlineAtMs)) {
      this.metrics.recordCounter('enforcement.suppressed.deadline');
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
      this.metrics.recordCounter('enforcement.suppressed.immunity');
      return { kind: 'completed' };
    }

    if (deadlineExpired(deadlineAtMs)) {
      this.metrics.recordCounter('enforcement.suppressed.deadline');
      return { kind: 'completed' };
    }
    const commitContext = await this.loadJobContext(job.chatId);
    if (
      !commitContext ||
      commitContext.entityType !== ChatEntityType.CHAT ||
      !commitContext.settings.commercialAdsFilterEnabled ||
      !sameCommercialPolicy(commitContext.settings, authorization.context.settings) ||
      commitContext.localAdminUserIds.includes(authorization.exactSource.senderId)
    ) {
      this.metrics.recordCounter('enforcement.suppressed.authorization');
      return { kind: 'completed' };
    }
    const commitSettingsFingerprint = fingerprintSettingsFailOpen(commitContext.settings);
    if (!commitSettingsFingerprint) {
      this.metrics.recordCounter('enforcement.suppressed.authorization');
      return { kind: 'completed' };
    }
    const commitRuntime = await this.runtimePolicy.resolveEffectivePolicy({
      chatId: job.chatId,
      settingsFingerprint: commitSettingsFingerprint,
    });
    const controlExpiresAtMs = Date.parse(commitRuntime.controlExpiresAt ?? '');
    const jobDeadlineExceeded = deadlineExpired(deadlineAtMs);
    const runtimeControlExpired =
      Number.isFinite(controlExpiresAtMs) && controlExpiresAtMs <= Date.now();
    if (
      !commitRuntime.enforce ||
      commitRuntime.controlRevision === null ||
      commitRuntime.controlExpiresAt === null ||
      !Number.isFinite(controlExpiresAtMs) ||
      runtimeControlExpired ||
      jobDeadlineExceeded
    ) {
      this.metrics.recordCounter(
        jobDeadlineExceeded
          ? 'enforcement.suppressed.deadline'
          : runtimeControlExpired
            ? 'enforcement.suppressed.runtime_control_expired'
            : 'enforcement.suppressed.runtime_control',
      );
      return { kind: 'completed' };
    }
    const deleteDeadlineAtMs = Math.min(deadlineAtMs, controlExpiresAtMs);
    const binding = buildCommercialOcrDeleteBinding({
      ocrVersion: job.ocrVersion,
      senderId: authorization.exactSource.senderId,
      orderedPhotoIds: authorization.exactSource.orderedPhotoIds,
      caption: authorization.exactSource.caption,
      sourceCreatedAt: authorization.exactSource.sourceCreatedAt,
      expectedImageCount: job.imageCount,
      settings: commitContext.settings,
      controlRevision: commitRuntime.controlRevision,
      controlExpiresAt: commitRuntime.controlExpiresAt,
      ocrDeadlineAt: new Date(deleteDeadlineAtMs),
    });
    await this.persistDeleteAction({
      job,
      jobId,
      binding,
      senderId: authorization.exactSource.senderId,
      sourceCreatedAt: authorization.exactSource.sourceCreatedAt,
      originBotId: authorization.originBotId,
      deadlineAtMs: deleteDeadlineAtMs,
    });
    this.metrics.recordCounter('enforcement.intent.requested');
    return { kind: 'completed' };
  }

  private async loadSource(
    job: CommercialOcrJob,
    deadlineAtMs: number,
  ): Promise<
    | { kind: 'ready'; value: SourceEnvelope }
    | { kind: 'defer'; delayMs: number }
    | { kind: 'terminal' }
  > {
    const webhookEvent = await this.prisma.webhookEvent
      .findUnique({
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
      })
      .catch(() => {
        this.logger.warn(
          'Commercial OCR webhook source lookup failed; enforcement remains fail-open',
        );
        return null;
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

    const updateRecord = asRecord(webhookEvent.normalizedPayload);
    if (!updateRecord) {
      return { kind: 'terminal' };
    }
    const update = updateRecord as unknown as MaxUpdate;
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
        'Skipped commercial OCR job whose source identity does not match the webhook',
      );
      return { kind: 'terminal' };
    }

    const originBotId =
      readString(webhookEvent.executionClaims[0]?.executionBotId) ??
      readString(webhookEvent.botId) ??
      readString(updateRecord.executionOwnerBotId) ??
      readString(update.botId) ??
      this.maxBotLinkService.getDefaultBotId();
    const exact = await this.loadExactSource(job, originBotId, deadlineAtMs);
    if (!exact || exact.authorKind !== 'user' || !sameAlbumSource(album, exact.source, job)) {
      return { kind: 'terminal' };
    }
    const refreshed = refreshAlbumDownloadUrls(album, exact.images);
    if (!refreshed) {
      return { kind: 'terminal' };
    }
    return {
      kind: 'ready',
      value: {
        update,
        album: refreshed.album,
        originBotId,
        exactSource: exact.source,
        persistedDownloadUrlFallbackIndexes: refreshed.persistedDownloadUrlFallbackIndexes,
      },
    };
  }

  private async loadExactSource(
    job: CommercialOcrJob,
    botId: string,
    deadlineAtMs: number,
  ): Promise<CommercialOcrExactMessageSource | null> {
    const timeoutMs = remainingStageTimeoutMs(deadlineAtMs, ADMIN_LOOKUP_TIMEOUT_MS);
    if (timeoutMs === null) {
      return null;
    }
    try {
      const row = await this.maxClient.getExactMessageRow(job.chatId, job.messageId, {
        trafficClass: 'background',
        sourceTag: GOVERNOR_SOURCE_TAG,
        botId,
        bypassCache: true,
        timeoutMs,
      });
      return row ? extractCommercialOcrExactMessageSource(row) : null;
    } catch {
      this.logger.warn('Commercial OCR exact source lookup failed; enforcement remains fail-open');
      return null;
    }
  }

  private async resolveFinalAuthorization(params: {
    job: CommercialOcrJob;
    jobId: string;
    initialContext: CommercialOcrJobContext;
    initialSource: SourceEnvelope;
    deadlineAtMs: number;
  }): Promise<{
    context: CommercialOcrJobContext;
    exactSource: CommercialOcrDeleteSource;
    originBotId: string;
  } | null> {
    if (deadlineExpired(params.deadlineAtMs)) {
      return null;
    }
    const admission = await this.admissionStore.resolveState(params.jobId);
    if (admission.kind !== 'available' || admission.state !== 'actionable') {
      return null;
    }
    if (
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
        params.deadlineAtMs,
      ))
    ) {
      return null;
    }

    const exact = await this.loadExactSource(
      params.job,
      params.initialSource.originBotId,
      params.deadlineAtMs,
    );
    const exactSource = exact?.source ?? null;
    if (
      !exactSource ||
      exact?.authorKind !== 'user' ||
      !sameAlbumSource(params.initialSource.album, exactSource, params.job) ||
      !sameExactSource(exactSource, params.initialSource.exactSource)
    ) {
      return null;
    }

    const finalAdmission = await this.admissionStore.resolveState(params.jobId);
    if (finalAdmission.kind !== 'available' || finalAdmission.state !== 'actionable') {
      return null;
    }
    if (deadlineExpired(params.deadlineAtMs)) {
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

  private async isFreshNonAdmin(
    chatId: string,
    userId: string,
    botId: string,
    deadlineAtMs: number,
  ): Promise<boolean> {
    const timeoutMs = remainingStageTimeoutMs(deadlineAtMs, ADMIN_LOOKUP_TIMEOUT_MS);
    if (timeoutMs === null) {
      return false;
    }
    try {
      const access = await this.maxClient.getChatMemberAccess(chatId, userId, {
        trafficClass: 'background',
        sourceTag: GOVERNOR_SOURCE_TAG,
        botId,
        bypassCache: true,
        timeoutMs,
      });
      return Boolean(
        access &&
        (access.userId === null || access.userId === userId) &&
        !access.isAdmin &&
        !access.isOwner,
      );
    } catch {
      this.logger.warn('Commercial OCR fresh admin check failed; enforcement remains fail-open');
      return false;
    }
  }

  private async authorizeHeavyStage(): Promise<boolean> {
    try {
      const decision = await this.governor.decide({
        component: GOVERNOR_COMPONENT,
        sourceTag: GOVERNOR_SOURCE_TAG,
        ignoredPressureDomains: ['max_api_traffic'],
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
    } catch {
      this.logger.warn(
        'Commercial OCR participant immunity check failed; enforcement remains fail-open',
      );
      return true;
    }
  }

  private async persistDeleteAction(params: {
    job: CommercialOcrJob;
    jobId: string;
    binding: CommercialOcrDeleteBinding;
    senderId: string;
    sourceCreatedAt: string;
    originBotId: string;
    deadlineAtMs: number;
  }): Promise<void> {
    const bindingDigest = createHash('sha256').update(JSON.stringify(params.binding)).digest('hex');
    try {
      await this.moderationDeleteIntents.ensureIntentWithMessageActionClaim({
        claim: {
          dedupeKey: `commercial-ocr-action:v1:${bindingDigest}`,
          messageActionKey: buildMessageScopedModerationActionClaimKey(
            params.job.chatId,
            params.job.messageId,
          ),
          chatId: params.job.chatId,
          userId: params.senderId,
          messageId: params.job.messageId,
          ruleCode: COMMERCIAL_OCR_MESSAGE_ACTION_RULE_CODE,
          updateType: 'message_action',
        },
        intent: {
          chatId: params.job.chatId,
          messageId: params.job.messageId,
          reasonKey: `commercial-ocr-delete:${params.jobId}`,
          ruleCode: COMMERCIAL_OCR_DELETE_RULE_CODE,
          subjectUserId: params.senderId,
          sourceMessageAt: params.sourceCreatedAt,
          entityType: 'CHAT',
          messageAuthorKind: 'user',
          originBotId: params.originBotId,
          routingPolicy: 'delete_capable',
          retryUntilAt: new Date(params.deadlineAtMs),
          commercialOcrDeadlineAt: new Date(params.deadlineAtMs),
          event: {
            userId: params.senderId,
            eventType: 'MESSAGE',
            score: 1,
            metadata: { commercialOcrBinding: params.binding },
          },
        },
      });
    } catch (error: unknown) {
      this.logger.warn(
        'Failed to atomically persist commercial OCR action ownership and delete intent',
      );
      throw error;
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
    source.caption === album.caption &&
    source.orderedPhotoIds.length === job.imageCount &&
    photoIds.length === source.orderedPhotoIds.length &&
    photoIds.every(
      (photoId, index) => photoId !== null && photoId === source.orderedPhotoIds[index],
    )
  );
}

function refreshAlbumDownloadUrls(
  album: LogicalPhotoAlbum,
  exactImages: CommercialOcrExactMessageSource['images'],
): {
  album: LogicalPhotoAlbum;
  persistedDownloadUrlFallbackIndexes: readonly number[];
} | null {
  if (album.images.length !== exactImages.length) {
    return null;
  }
  const persistedDownloadUrlFallbackIndexes: number[] = [];
  const images = album.images.map((image, index) => {
    const exact = exactImages[index];
    if (
      !exact ||
      image.photoId === null ||
      exact.photoId === null ||
      image.photoId !== exact.photoId ||
      image.source !== exact.source
    ) {
      return null;
    }
    if (exact.downloadUrl === null && image.downloadUrl !== null) {
      persistedDownloadUrlFallbackIndexes.push(index);
    }
    return {
      ...image,
      downloadUrl: exact.downloadUrl ?? image.downloadUrl,
    };
  });
  if (images.some((image) => image === null)) {
    return null;
  }
  return {
    album: { ...album, images: images as LogicalPhotoAlbum['images'] },
    persistedDownloadUrlFallbackIndexes,
  };
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

function fingerprintSettingsFailOpen(settings: ChatSettings): string | null {
  try {
    return fingerprintCommercialOcrSettingsProfile(settings);
  } catch {
    return null;
  }
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

function deadlineExpired(deadlineAtMs: number): boolean {
  return !Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= Date.now();
}

function remainingStageTimeoutMs(deadlineAtMs: number, stageCeilingMs: number): number | null {
  const remainingMs = deadlineAtMs - Date.now();
  if (
    !Number.isSafeInteger(deadlineAtMs) ||
    !Number.isSafeInteger(stageCeilingMs) ||
    stageCeilingMs <= 0 ||
    remainingMs <= 0
  ) {
    return null;
  }
  return Math.max(1, Math.min(stageCeilingMs, remainingMs));
}
