import { Inject, Injectable, Logger } from '@nestjs/common';
import type { MaxUpdate } from '@maxim/contracts';
import { createHash } from 'node:crypto';
import { MaxBotContextService } from '../../max/max-bot-context.service';
import { MaxBotLinkService } from '../../max/max-bot-link.service';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../../max/max-client.service';
import { ChatEntityType, WebhookStatus, type ChatSettings } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { isPendingWebhookTimeoutQuarantineMessage } from '../../webhook/webhook-timeout-quarantine';
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
import { ModerationDeleteIntentService } from '../moderation-delete-intent.service';
import type { DuplicateAction, DuplicateDecision, DuplicateHit } from '../rule-engine.contract';
import {
  extractLogicalPhotoAlbumResult,
  type LogicalPhotoAlbum,
} from './photo-attachment-extractor';
import { PhotoDuplicateAnalysisService } from './photo-duplicate-analysis.service';
import type {
  PhotoHistoryViolationAction,
  PhotoHistoryViolationActionBinding,
} from './photo-duplicate-history.store';
import {
  buildPhotoDuplicateActionClaimDedupeKey,
  PHOTO_DUPLICATE_ACTION_CLAIM_DEDUPE_PREFIX,
  PHOTO_DUPLICATE_MESSAGE_ACTION_CLAIM_RULE_CODE,
  PHOTO_DUPLICATE_MODERATION_ACTIONS,
  type ActionablePhotoDuplicateBinding,
  type PhotoDuplicateModerationActions,
} from './photo-duplicate-moderation.actions';
import type { PhotoDuplicateOrderingLease } from './photo-duplicate-ordering.store';
import {
  PHOTO_DUPLICATE_ALGORITHM_VERSION,
  PhotoDuplicateSourceNotReadyError,
  type PhotoDuplicateJob,
} from './photo-duplicate.queue';
import {
  capPhotoDuplicateAction,
  isPhotoDuplicateMatchKindAllowed,
  restrictPhotoDuplicateMaxAction,
  type PhotoDuplicateMatchKind,
  type PhotoDuplicateMaxAction,
  type PhotoDuplicateRolloutMode,
} from './photo-duplicate.runtime';
import {
  PhotoDuplicateRuntimePolicyService,
  type EffectivePhotoDuplicateRuntimePolicy,
} from './photo-duplicate-runtime-policy.service';
import { PHOTO_FINGERPRINT_ALGORITHM_VERSION } from './photo-fingerprint';

const PHOTO_DUPLICATE_ACTION_BINDING_VERSION = 2;

export type PhotoDuplicateIntendedAction = PhotoHistoryViolationAction;

export type PhotoDuplicateActionBinding = PhotoHistoryViolationActionBinding;

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

type FreshPhotoDuplicateAuthorization = {
  context: PhotoDuplicateJobContext;
  flow: DuplicateFlowConfig;
  policy: EffectivePhotoDuplicateRuntimePolicy;
};

export class PhotoDuplicateViolationCommitUnavailableError extends Error {
  readonly retryable = true;

  constructor() {
    super('Photo duplicate violation commit is unavailable');
    this.name = 'PhotoDuplicateViolationCommitUnavailableError';
  }
}

@Injectable()
export class PhotoDuplicateModerationService {
  private readonly logger = new Logger(PhotoDuplicateModerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly analysisService: PhotoDuplicateAnalysisService,
    private readonly maxClient: MaxClientService,
    private readonly moderationAccessService: ModerationAccessService,
    private readonly moderationDeleteIntents: ModerationDeleteIntentService,
    private readonly runtimePolicy: PhotoDuplicateRuntimePolicyService,
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
        errorMessage: true,
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
      (webhookEvent.status === WebhookStatus.FAILED &&
        webhookEvent.nextEnqueueAt === null &&
        !isPendingWebhookTimeoutQuarantineMessage(webhookEvent.errorMessage))
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

    const initialPolicy = await this.runtimePolicy.resolveEffectivePolicy({
      chatId: album.chatId,
      preset: initialContext.settings.duplicatePhotoMatchPreset,
      scope: initialContext.settings.duplicatePhotoScope,
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
      this.moderationDeleteIntents.getRolloutForRule(album.chatId, 'DUPLICATE_DELETE') ===
        'execute' &&
      !initialActionFence.blocked &&
      initialAdminCheck !== null &&
      initialAdminCheck.source !== 'local_fallback' &&
      !releaseSuppressesEnforcement;
    const authorizationConfigDigest = buildPhotoDuplicateAuthorizationConfigDigest({
      settings: initialContext.settings,
      flow,
      rolloutMode: initialPolicy.mode,
      allowedMatchKinds: initialPolicy.allowedMatchKinds,
      maxAction: initialPolicy.maxAction,
      rulesPublishedUrl: initialContext.rulesPublishedUrl,
      rulesPublishedMessageId: initialContext.rulesPublishedMessageId,
    });

    // FLAG: Analysis is observation-only. It may establish a baseline in shadow mode, but the
    // sanction counter is committed only after every execution-time guard below has passed.
    lease.assertOwned();
    const analysis = await this.analysisService.analyzeAlbum({
      album,
      ttlSeconds: flow.windowSec + 1,
      scope: initialContext.settings.duplicatePhotoScope,
      preset: initialContext.settings.duplicatePhotoMatchPreset,
      actionEligible,
      authorizationConfigDigest,
      allowedViolationMatchKinds: initialPolicy.allowedMatchKinds,
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

    const actionPolicy = await this.runtimePolicy.resolveEffectivePolicy({
      chatId: album.chatId,
      preset: actionContext.settings.duplicatePhotoMatchPreset,
      scope: actionContext.settings.duplicatePhotoScope,
    });
    // FLAG: The match kind is known only after analysis. Re-read policy and reject it before any
    // immunity consumption or action binding; a global full rollout alone cannot authorize PDQ.
    const matchKind = observation.matchKind;
    if (
      !actionPolicy.enforce ||
      matchKind === null ||
      !isPhotoDuplicateMatchKindAllowed(actionPolicy, matchKind)
    ) {
      return;
    }
    const actionFlow = resolveDuplicateFlowConfig(actionContext.settings);
    if (!duplicateFlowConfigsEqual(flow, actionFlow)) {
      return;
    }
    const actionAuthorizationConfigDigest = buildPhotoDuplicateAuthorizationConfigDigest({
      settings: actionContext.settings,
      flow: actionFlow,
      rolloutMode: actionPolicy.mode,
      allowedMatchKinds: actionPolicy.allowedMatchKinds,
      maxAction: actionPolicy.maxAction,
      rulesPublishedUrl: actionContext.rulesPublishedUrl,
      rulesPublishedMessageId: actionContext.rulesPublishedMessageId,
    });
    if (actionAuthorizationConfigDigest !== authorizationConfigDigest) {
      return;
    }

    const fingerprintType = analysis.imageCount === 1 ? 'image' : 'image_set';
    const provisionalOutcome = resolveDuplicateFlowOutcome({
      settings: actionContext.settings,
      repeatCount: observation.repeatCount,
      hash: observation.sanctionClusterId.slice(0, 20),
      fingerprintType,
    });
    const enforcementMode = resolveEffectivePhotoDuplicateMode(
      initialPolicy.mode,
      actionPolicy.mode,
    );
    // FLAG: A photo job may only retain the least permissive action ceiling it has observed.
    // DELETE_MESSAGE maps every configured WARN/MUTE/BAN decision back to a delete-only hit.
    const maxAction = restrictPhotoDuplicateMaxAction(
      initialPolicy.maxAction,
      actionPolicy.maxAction,
    );
    const provisionalActionOutcome = provisionalOutcome.hit
      ? capPhotoDuplicateOutcome({
          hit: provisionalOutcome.hit,
          decision: provisionalOutcome.decision,
          enforcementMode,
          maxAction,
          settings: actionContext.settings,
        })
      : null;
    const intendedAction: PhotoDuplicateIntendedAction = provisionalActionOutcome
      ? provisionalActionOutcome.kind === 'decision'
        ? provisionalActionOutcome.decision.action
        : 'HIT'
      : 'NONE';
    const actionBinding = buildPhotoDuplicateActionBinding({
      settings: actionContext.settings,
      flow: actionFlow,
      rolloutMode: enforcementMode,
      intendedAction,
      matchKind,
      maxAction,
      rulesPublishedUrl: actionContext.rulesPublishedUrl,
      rulesPublishedMessageId: actionContext.rulesPublishedMessageId,
    });
    const actionableBinding: ActionablePhotoDuplicateBinding | null =
      intendedAction === 'NONE'
        ? null
        : { intendedAction, configDigest: actionBinding.configDigest };
    const actionFence = await this.resolveMessageActionFence({
      chatId: album.chatId,
      userId: album.senderId,
      messageId: album.messageId,
      ...(actionableBinding ? { expectedBinding: actionableBinding } : {}),
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

    let actionOutcome: PhotoDuplicateExecutionOutcome | null = null;
    if (intendedAction !== 'NONE') {
      const duplicateMetadata = {
        duplicateSource: 'photo',
        fingerprintType,
        albumSize: analysis.imageCount,
        matchKind,
        distance: observation.matchedDistance,
        preset: actionContext.settings.duplicatePhotoMatchPreset,
        scope: actionContext.settings.duplicatePhotoScope,
        algorithmVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
        rolloutMode: enforcementMode,
        maxAction,
        photoDuplicateActionBindingVersion: PHOTO_DUPLICATE_ACTION_BINDING_VERSION,
        photoDuplicateIntendedAction: actionBinding.intendedAction,
        photoDuplicateFlowConfigDigest: actionBinding.configDigest,
      } satisfies Record<string, unknown>;
      const outcome = resolveDuplicateFlowOutcome({
        settings: actionContext.settings,
        repeatCount: observation.repeatCount,
        hash: observation.sanctionClusterId.slice(0, 20),
        fingerprintType,
        metadata: duplicateMetadata,
      });
      if (!outcome.hit) {
        return;
      }
      actionOutcome = capPhotoDuplicateOutcome({
        hit: outcome.hit,
        decision: outcome.decision,
        enforcementMode,
        maxAction,
        settings: actionContext.settings,
      });
      if (actionOutcome.kind === 'decision' && actionOutcome.decision.action !== intendedAction) {
        return;
      }
      if (actionOutcome.kind === 'hit' && intendedAction !== 'HIT') {
        return;
      }
    }

    if (!(await lease.resolveActionEligibility())) {
      return;
    }
    lease.assertOwned();
    if (
      actionOutcome &&
      (await this.actions.consumePhotoDuplicateParticipantImmunity({
        chatId: album.chatId,
        userId: album.senderId,
        nightModeTimezone: actionContext.settings.nightModeTimezone,
      }))
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
    // FLAG: This is the last execution-time ceiling read before the counter commit. Combine every
    // snapshot monotonically so a mid-job upgrade cannot strengthen the action and a downgrade
    // cancels the stale dispatch.
    const finalPolicy = await this.runtimePolicy.resolveEffectivePolicy({
      chatId: album.chatId,
      preset: actionContext.settings.duplicatePhotoMatchPreset,
      scope: actionContext.settings.duplicatePhotoScope,
    });
    const finalAuthorizationConfigDigest = buildPhotoDuplicateAuthorizationConfigDigest({
      settings: actionContext.settings,
      flow: actionFlow,
      rolloutMode: finalPolicy.mode,
      allowedMatchKinds: finalPolicy.allowedMatchKinds,
      maxAction: finalPolicy.maxAction,
      rulesPublishedUrl: actionContext.rulesPublishedUrl,
      rulesPublishedMessageId: actionContext.rulesPublishedMessageId,
    });
    if (
      !finalPolicy.enforce ||
      !isPhotoDuplicateMatchKindAllowed(finalPolicy, matchKind) ||
      finalAuthorizationConfigDigest !== authorizationConfigDigest ||
      resolveEffectivePhotoDuplicateMode(
        initialPolicy.mode,
        actionPolicy.mode,
        finalPolicy.mode,
      ) !== enforcementMode ||
      restrictPhotoDuplicateMaxAction(
        initialPolicy.maxAction,
        actionPolicy.maxAction,
        finalPolicy.maxAction,
      ) !== maxAction
    ) {
      return;
    }
    lease.assertOwned();
    const precommitFence = await this.resolveMessageActionFence({
      chatId: album.chatId,
      userId: album.senderId,
      messageId: album.messageId,
      ...(actionableBinding ? { expectedBinding: actionableBinding } : {}),
    });
    if (precommitFence.blocked) {
      return;
    }
    let actionClaimed = precommitFence.actionClaimed;
    if (actionableBinding && !actionClaimed) {
      lease.assertOwned();
      const claim = await this.actions.claimPhotoDuplicateAction({
        chatId: album.chatId,
        userId: album.senderId,
        messageId: album.messageId,
        actionBinding: actionableBinding,
      });
      lease.assertOwned();
      if (claim === 'blocked') {
        return;
      }
      actionClaimed = true;
    }
    lease.assertOwned();
    const violationCommit = await this.analysisService.commitViolation({
      album,
      albumHash: analysis.albumHash,
      ttlSeconds: actionFlow.windowSec + 1,
      scope: actionContext.settings.duplicatePhotoScope,
      preset: actionContext.settings.duplicatePhotoMatchPreset,
      observationClusterId: observation.clusterId,
      matchKind,
      expectedRepeatCount: observation.repeatCount,
      allowedMatchKinds: finalPolicy.allowedMatchKinds,
      authorizationConfigDigest,
      actionBinding,
    });
    lease.assertOwned();
    if (violationCommit.kind !== 'available') {
      throw new PhotoDuplicateViolationCommitUnavailableError();
    }
    if (
      violationCommit.repeatCount !== observation.repeatCount ||
      violationCommit.sanctionClusterId !== observation.sanctionClusterId ||
      !violationCommit.bindingMatches ||
      !photoDuplicateActionBindingsEqual(violationCommit.actionBinding, actionBinding)
    ) {
      this.logger.warn(
        {
          chatId: album.chatId,
          messageId: album.messageId,
          bindingMatches: violationCommit.bindingMatches,
        },
        'Photo duplicate violation commit did not match its immutable observation binding',
      );
      return;
    }
    if (!actionOutcome || !actionableBinding) {
      return;
    }
    const dispatchContext = await this.loadJobContext(album.chatId);
    if (
      !dispatchContext ||
      dispatchContext.entityType !== ChatEntityType.CHAT ||
      !dispatchContext.settings.antiDuplicateEnabled ||
      !dispatchContext.settings.duplicatePhotoEnabled
    ) {
      return;
    }
    const dispatchFlow = resolveDuplicateFlowConfig(dispatchContext.settings);
    const dispatchPolicy = await this.runtimePolicy.resolveEffectivePolicy({
      chatId: album.chatId,
      preset: dispatchContext.settings.duplicatePhotoMatchPreset,
      scope: dispatchContext.settings.duplicatePhotoScope,
    });
    const dispatchAuthorizationConfigDigest = buildPhotoDuplicateAuthorizationConfigDigest({
      settings: dispatchContext.settings,
      flow: dispatchFlow,
      rolloutMode: dispatchPolicy.mode,
      allowedMatchKinds: dispatchPolicy.allowedMatchKinds,
      maxAction: dispatchPolicy.maxAction,
      rulesPublishedUrl: dispatchContext.rulesPublishedUrl,
      rulesPublishedMessageId: dispatchContext.rulesPublishedMessageId,
    });
    if (
      !dispatchPolicy.enforce ||
      !isPhotoDuplicateMatchKindAllowed(dispatchPolicy, matchKind) ||
      dispatchAuthorizationConfigDigest !== authorizationConfigDigest
    ) {
      return;
    }
    const actionRequest = {
      update,
      chatId: album.chatId,
      userId: album.senderId,
      messageId: album.messageId,
      settings: dispatchContext.settings,
      rulesPublishedUrl: dispatchContext.rulesPublishedUrl,
      rulesPublishedMessageId: dispatchContext.rulesPublishedMessageId,
      actionClaimed,
      lease,
      authorizeDelete: () =>
        this.resolveFreshDeleteAuthorization({
          album,
          expectedBinding: actionableBinding,
          authorizationConfigDigest,
          matchKind,
          lease,
        }),
    } as const;
    if (actionOutcome.kind === 'decision') {
      await this.actions.executePhotoDuplicateAction({
        ...actionRequest,
        outcome: actionOutcome,
        authorizeSanction: () =>
          this.resolveFreshSanctionAuthorization({
            album,
            expectedDecision: actionOutcome.decision,
            expectedBinding: actionableBinding,
            authorizationConfigDigest,
            matchKind,
            lease,
          }),
      });
    } else {
      await this.actions.executePhotoDuplicateAction({ ...actionRequest, outcome: actionOutcome });
    }
    lease.assertOwned();
  }

  private async resolveFreshDeleteAuthorization(params: {
    album: LogicalPhotoAlbum;
    expectedBinding: ActionablePhotoDuplicateBinding;
    authorizationConfigDigest: string;
    matchKind: PhotoDuplicateMatchKind;
    lease: PhotoDuplicateOrderingLease;
  }): Promise<boolean> {
    return Boolean(
      await this.resolveFreshActionAuthorization({
        ...params,
        requireFullMode: false,
      }),
    );
  }

  // FLAG: DELETE may take long enough for chat policy or membership to change. The actions port
  // invokes this callback inside the sanction lock, immediately before WARN/MUTE/BAN.
  private async resolveFreshSanctionAuthorization(params: {
    album: LogicalPhotoAlbum;
    expectedDecision: DuplicateDecision;
    expectedBinding: ActionablePhotoDuplicateBinding | null;
    authorizationConfigDigest: string;
    matchKind: PhotoDuplicateMatchKind;
    lease: PhotoDuplicateOrderingLease;
  }): Promise<boolean> {
    if (!params.expectedBinding) {
      return false;
    }
    const authorization = await this.resolveFreshActionAuthorization({
      album: params.album,
      expectedBinding: params.expectedBinding,
      authorizationConfigDigest: params.authorizationConfigDigest,
      matchKind: params.matchKind,
      lease: params.lease,
      requireFullMode: true,
    });
    if (!authorization) {
      return false;
    }
    const { context, flow, policy } = authorization;
    const outcome = resolveDuplicateFlowOutcome({
      settings: context.settings,
      repeatCount: params.expectedDecision.count,
      hash: params.expectedDecision.hash,
      fingerprintType: params.expectedDecision.fingerprintType,
      metadata: params.expectedDecision.metadata,
    });
    if (!outcome.hit) {
      return false;
    }
    const currentOutcome = capPhotoDuplicateOutcome({
      hit: outcome.hit,
      decision: outcome.decision,
      enforcementMode: 'full',
      maxAction: policy.maxAction,
      settings: context.settings,
    });
    if (
      currentOutcome.kind !== 'decision' ||
      currentOutcome.decision.action !== params.expectedDecision.action
    ) {
      return false;
    }
    const currentBinding = buildPhotoDuplicateActionBinding({
      settings: context.settings,
      flow,
      rolloutMode: policy.mode,
      intendedAction: currentOutcome.decision.action,
      matchKind: params.matchKind,
      maxAction: policy.maxAction,
      rulesPublishedUrl: context.rulesPublishedUrl,
      rulesPublishedMessageId: context.rulesPublishedMessageId,
    });
    if (!photoDuplicateActionBindingsEqual(currentBinding, params.expectedBinding)) {
      return false;
    }
    params.lease.assertOwned();
    return true;
  }

  // FLAG: Runtime control is the final asynchronous read. No awaited work may follow it before
  // the caller crosses the DELETE or sanction mutation boundary.
  private async resolveFreshActionAuthorization(params: {
    album: LogicalPhotoAlbum;
    expectedBinding: ActionablePhotoDuplicateBinding;
    authorizationConfigDigest: string;
    matchKind: PhotoDuplicateMatchKind;
    lease: PhotoDuplicateOrderingLease;
    requireFullMode: boolean;
  }): Promise<FreshPhotoDuplicateAuthorization | null> {
    params.lease.assertOwned();
    const actionFence = await this.resolveMessageActionFence({
      chatId: params.album.chatId,
      userId: params.album.senderId,
      messageId: params.album.messageId,
      expectedBinding: params.expectedBinding,
    });
    if (actionFence.blocked || !actionFence.actionClaimed) {
      return null;
    }
    const adminCheck = await this.resolveFreshAdminCheck({
      chatId: params.album.chatId,
      userId: params.album.senderId,
      localAdminUserIds: [],
    });
    if (adminCheck !== 'non_admin') {
      return null;
    }
    const manualReleaseAt = await this.resolveLatestManualReleaseCreatedAt(
      params.album.chatId,
      params.album.senderId,
    );
    if (!(await params.lease.resolveActionEligibility())) {
      return null;
    }
    params.lease.assertOwned();

    const context = await this.loadJobContext(params.album.chatId);
    if (
      !context ||
      context.entityType !== ChatEntityType.CHAT ||
      !context.settings.antiDuplicateEnabled ||
      !context.settings.duplicatePhotoEnabled ||
      context.adminUserIds.includes(params.album.senderId)
    ) {
      return null;
    }
    const flow = resolveDuplicateFlowConfig(context.settings);
    if (
      Date.now() - params.album.createdAtMs > flow.windowSec * 1_000 ||
      (manualReleaseAt !== null && isWithinWindow(manualReleaseAt, flow.windowSec))
    ) {
      return null;
    }

    const policy = await this.runtimePolicy.resolveEffectivePolicy({
      chatId: params.album.chatId,
      preset: context.settings.duplicatePhotoMatchPreset,
      scope: context.settings.duplicatePhotoScope,
    });
    if (
      !policy.enforce ||
      (params.requireFullMode && policy.mode !== 'full') ||
      !isPhotoDuplicateMatchKindAllowed(policy, params.matchKind)
    ) {
      return null;
    }
    const currentAuthorizationConfigDigest = buildPhotoDuplicateAuthorizationConfigDigest({
      settings: context.settings,
      flow,
      rolloutMode: policy.mode,
      allowedMatchKinds: policy.allowedMatchKinds,
      maxAction: policy.maxAction,
      rulesPublishedUrl: context.rulesPublishedUrl,
      rulesPublishedMessageId: context.rulesPublishedMessageId,
    });
    if (currentAuthorizationConfigDigest !== params.authorizationConfigDigest) {
      return null;
    }
    const currentBinding = buildPhotoDuplicateActionBinding({
      settings: context.settings,
      flow,
      rolloutMode: policy.mode,
      intendedAction: params.expectedBinding.intendedAction,
      matchKind: params.matchKind,
      maxAction: policy.maxAction,
      rulesPublishedUrl: context.rulesPublishedUrl,
      rulesPublishedMessageId: context.rulesPublishedMessageId,
    });
    if (!photoDuplicateActionBindingsEqual(currentBinding, params.expectedBinding)) {
      return null;
    }
    params.lease.assertOwned();
    return { context, flow, policy };
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
    expectedBinding?: ActionablePhotoDuplicateBinding;
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
            dedupeKey: true,
            messageActionKey: true,
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
      const expectedClaimDedupeKey = params.expectedBinding
        ? buildPhotoDuplicateActionClaimDedupeKey({
            chatId: params.chatId,
            userId: params.userId,
            messageId: params.messageId,
            actionBinding: params.expectedBinding,
          })
        : null;
      const boundPhotoActionClaims = messageActionClaims.filter(
        (claim) =>
          claim.userId === params.userId &&
          claim.ruleCode === PHOTO_DUPLICATE_MESSAGE_ACTION_CLAIM_RULE_CODE &&
          (readString(claim.dedupeKey) ?? '').startsWith(
            PHOTO_DUPLICATE_ACTION_CLAIM_DEDUPE_PREFIX,
          ),
      );
      const boundClaimOwnsAction =
        boundPhotoActionClaims.length === 1 &&
        (expectedClaimDedupeKey === null ||
          boundPhotoActionClaims[0]?.dedupeKey === expectedClaimDedupeKey);
      // Legacy duplicate claims are intentionally not recoverable here. Their key does not encode
      // whether text or photo moderation won, and the old flow persisted a photo intent before it
      // attempted the shared claim. Treating that pair as ownership could replay a second sanction.
      const ownedClaimCount = boundClaimOwnsAction ? 1 : 0;
      const hasForeignClaim = messageActionClaims.length !== ownedClaimCount;
      const bindingMismatch = Boolean(
        params.expectedBinding &&
        persistedBinding &&
        !photoDuplicateActionBindingsEqual(params.expectedBinding, persistedBinding),
      );

      if (
        hasCompletedPhotoFollowUp ||
        hasUnexpectedOwnPhotoEvent ||
        (hasForeignDeleteReason && !boundClaimOwnsAction) ||
        hasForeignEvent ||
        hasForeignClaim ||
        (deleteIntent !== null && !ownPhotoDeleteIntent && !boundClaimOwnsAction) ||
        (ownPhotoDeleteIntent && !persistedBinding) ||
        bindingMismatch
      ) {
        return { blocked: true, actionClaimed: false, persistedBinding: null };
      }

      return {
        blocked: false,
        actionClaimed: boundClaimOwnsAction,
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

type PhotoDuplicateExecutionOutcome =
  | { kind: 'hit'; hit: DuplicateHit }
  | { kind: 'decision'; decision: DuplicateDecision };

function capPhotoDuplicateOutcome(params: {
  hit: DuplicateHit;
  decision?: DuplicateDecision;
  enforcementMode: 'delete_only' | 'full';
  maxAction: PhotoDuplicateMaxAction;
  settings: ChatSettings;
}): PhotoDuplicateExecutionOutcome {
  if (params.enforcementMode !== 'full' || !params.decision) {
    return { kind: 'hit', hit: params.hit };
  }
  const action = resolveEnabledCappedAction(
    params.decision.action,
    params.maxAction,
    params.settings,
  );
  if (!action) {
    return { kind: 'hit', hit: params.hit };
  }
  const cappedNextAction = params.decision.nextAction
    ? resolveEnabledCappedAction(params.decision.nextAction, params.maxAction, params.settings)
    : null;
  return {
    kind: 'decision',
    decision: {
      ...params.decision,
      action,
      nextAction: cappedNextAction === action ? null : cappedNextAction,
    },
  };
}

const PHOTO_DUPLICATE_ACTION_ORDER = ['WARN', 'MUTE', 'BAN'] as const;

function resolveEnabledCappedAction(
  requestedAction: DuplicateAction,
  maxAction: PhotoDuplicateMaxAction,
  settings: ChatSettings,
): DuplicateAction | null {
  const cappedAction = capPhotoDuplicateAction(requestedAction, maxAction);
  if (!cappedAction) {
    return null;
  }
  const cappedIndex = PHOTO_DUPLICATE_ACTION_ORDER.indexOf(cappedAction);
  for (let index = cappedIndex; index >= 0; index -= 1) {
    const candidate = PHOTO_DUPLICATE_ACTION_ORDER[index];
    if (
      candidate &&
      ((candidate === 'WARN' && settings.duplicateWarnEnabled) ||
        (candidate === 'MUTE' && settings.duplicateMuteEnabled) ||
        (candidate === 'BAN' && settings.duplicateBanEnabled))
    ) {
      return candidate;
    }
  }
  return null;
}

function resolveEffectivePhotoDuplicateMode(
  first: PhotoDuplicateRolloutMode,
  ...rest: PhotoDuplicateRolloutMode[]
): 'delete_only' | 'full' {
  return first === 'full' && rest.every((mode) => mode === 'full') ? 'full' : 'delete_only';
}

type PhotoDuplicateSemanticConfigParams = {
  settings: ChatSettings;
  flow: DuplicateFlowConfig;
  rolloutMode: PhotoDuplicateRolloutMode;
  maxAction: PhotoDuplicateMaxAction;
  rulesPublishedUrl: string | null;
  rulesPublishedMessageId: string | null;
};

function buildPhotoDuplicateAuthorizationConfigDigest(
  params: PhotoDuplicateSemanticConfigParams & {
    allowedMatchKinds: readonly PhotoDuplicateMatchKind[];
  },
): string {
  return hashPhotoDuplicateConfig({
    ...buildPhotoDuplicateSemanticConfig(params),
    allowedMatchKinds: [...params.allowedMatchKinds].sort(),
  });
}

export function buildPhotoDuplicateActionBinding(params: {
  settings: PhotoDuplicateSemanticConfigParams['settings'];
  flow: PhotoDuplicateSemanticConfigParams['flow'];
  rolloutMode: PhotoDuplicateSemanticConfigParams['rolloutMode'];
  intendedAction: PhotoDuplicateIntendedAction;
  matchKind: PhotoDuplicateMatchKind;
  maxAction: PhotoDuplicateSemanticConfigParams['maxAction'];
  rulesPublishedUrl: PhotoDuplicateSemanticConfigParams['rulesPublishedUrl'];
  rulesPublishedMessageId: PhotoDuplicateSemanticConfigParams['rulesPublishedMessageId'];
}): PhotoDuplicateActionBinding {
  const config = {
    ...buildPhotoDuplicateSemanticConfig(params),
    intendedAction: params.intendedAction,
    matchKind: params.matchKind,
  };
  return {
    intendedAction: params.intendedAction,
    configDigest: hashPhotoDuplicateConfig(config),
  };
}

function buildPhotoDuplicateSemanticConfig(params: PhotoDuplicateSemanticConfigParams) {
  return {
    version: PHOTO_DUPLICATE_ACTION_BINDING_VERSION,
    rolloutMode: params.rolloutMode,
    maxAction: params.maxAction,
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
}

function hashPhotoDuplicateConfig(config: unknown): string {
  return createHash('sha256').update(canonicalJson(config)).digest('hex');
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
