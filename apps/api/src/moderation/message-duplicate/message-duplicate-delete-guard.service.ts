import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { extractHttpStatusCode } from '../../common/http-error.util';
import { MaxBotLinkService } from '../../max/max-bot-link.service';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../../max/max-client.service';
import {
  isMaxMutationOutcomeAmbiguous,
  wasMaxMessageSendAttempted,
} from '../../max/max-mutation-outcome.util';
import { wasMaxMemberMutationAttempted } from '../../max/max-member-error.util';
import { PrismaService } from '../../prisma/prisma.service';
import { WebhookParser } from '../../webhook/webhook.parser';
import { WebhookLegacyHoldService } from '../../webhook/webhook-legacy-hold.service';
import { ParticipantModerationImmunityService } from '../participant-moderation-immunity.service';
import { resolveDuplicateFlowConfig, resolveDuplicateFlowOutcome } from '../duplicate-flow-policy';
import { MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES } from '../moderation.service.support';
import {
  buildMessageDuplicateIdentity,
  extractDuplicateMessageContent,
  exactImageSourceDigest,
} from './message-duplicate-content';
import {
  duplicateSourceDigest,
  MessageDuplicateHistoryService,
} from './message-duplicate-history.service';
import { MessageDuplicatePolicyService } from './message-duplicate-policy.service';
import { MessageDuplicateMetricsService } from './message-duplicate-metrics.service';
import { isDuplicateScheduleOpen, resolveDuplicateDailyWindow } from './message-duplicate-schedule';
import {
  MESSAGE_DUPLICATE_SOURCE,
  messageDuplicateSettingsDigest,
  messageDuplicateOriginalSchema,
  exactImageSettingsDigest,
  messageDuplicateSanctionSettingsDigest,
  parseMessageDuplicateBinding,
  messageDuplicateEnforcementScope,
  type MessageDuplicateBinding,
} from './message-duplicate-state';
import { MessageDuplicateAuthorizationService } from './message-duplicate-authorization.service';
import {
  MessageDuplicateGuardRejectedError,
  MessageDuplicateQualificationSourceUnavailableError,
} from './message-duplicate-guard.contract';
export { MessageDuplicateGuardRejectedError } from './message-duplicate-guard.contract';
import {
  messageDuplicateNoticeSettingsDigest,
  readMessageDuplicateNoticeProof,
  type MessageDuplicateNoticeProof,
} from './message-duplicate-notice-proof';

type MessageDuplicateGuardInput = {
  chatId: string;
  messageId: string;
  subjectUserId: string | null;
  botId: string;
  binding: MessageDuplicateBinding;
  sanctionIntentId?: string;
  notice?: MessageDuplicateNoticeProof;
  beforeFinalAuthority?: () => Promise<void>;
};

@Injectable()
export class MessageDuplicateDeleteGuardService {
  private readonly parser = new WebhookParser();
  private readonly timeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly max: MaxClientService,
    private readonly bots: MaxBotLinkService,
    private readonly immunity: ParticipantModerationImmunityService,
    private readonly policy: MessageDuplicatePolicyService,
    private readonly history: MessageDuplicateHistoryService,
    config: ConfigService,
    private readonly authorization: MessageDuplicateAuthorizationService,
    @Optional() private readonly metrics?: MessageDuplicateMetricsService,
    @Optional() private readonly legacyHolds?: WebhookLegacyHoldService,
  ) {
    this.timeoutMs = config.get<number>('MODERATION_DELETE_INTENT_TIMEOUT_MS') ?? 5000;
  }

  async assertIntentStillActionable(params: {
    intentId: string;
    chatId: string;
    messageId: string;
    subjectUserId: string | null;
    botId: string;
    authorityOnly?: boolean;
  }): Promise<'allowed' | 'absent' | 'not_applicable'> {
    const reasons = await this.prisma.moderationDeleteIntentReason.findMany({
      where: { intentId: params.intentId },
      select: { ruleCode: true, reasonKey: true, metadata: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 65,
    });
    if (reasons.length === 0) {
      this.metrics?.recordGuardRejection('message_duplicate_reason_missing');
      throw new MessageDuplicateGuardRejectedError('message_duplicate_reason_missing');
    }
    if (reasons.length > 64) {
      this.metrics?.recordGuardRejection('message_duplicate_reason_limit');
      throw new MessageDuplicateGuardRejectedError('message_duplicate_reason_limit');
    }
    const owned = reasons.filter(
      (reason) =>
        reason.reasonKey.startsWith('MESSAGE_DUPLICATE:') ||
        (reason.metadata as Record<string, unknown> | null)?.duplicateSource ===
          MESSAGE_DUPLICATE_SOURCE,
    );
    if (owned.length === 0) return 'not_applicable';
    // FLAG: Mixed guarded reasons must not mutually bypass their current-content checks.
    const bindings = owned.map((reason) =>
      reason.ruleCode === 'DUPLICATE_DELETE' ? parseMessageDuplicateBinding(reason.metadata) : null,
    );
    if (bindings.some((binding) => !binding)) {
      this.metrics?.recordGuardRejection('message_duplicate_binding_invalid');
      throw new MessageDuplicateGuardRejectedError('message_duplicate_binding_invalid');
    }
    const binding = (bindings as MessageDuplicateBinding[]).sort(
      (a, b) => b.eventTimestampMs - a.eventTimestampMs,
    )[0]!;
    if (params.authorityOnly) {
      await this.assertQualificationAuthority(params.chatId, binding);
      if (!(await this.history.stillMatches(params.chatId, binding)))
        throw new MessageDuplicateGuardRejectedError('message_duplicate_history_changed');
      await this.assertAuthorization(params.chatId, binding);
      return 'allowed';
    }
    return this.assertMessageStillActionable({ ...params, binding });
  }

  async assertMessageStillActionable(
    params: MessageDuplicateGuardInput,
  ): Promise<'allowed' | 'absent'> {
    return this.assertSourceActionable(params, false);
  }

  private async assertSourceActionable(
    params: MessageDuplicateGuardInput,
    initialQualification: boolean,
  ): Promise<'allowed' | 'absent'> {
    try {
      const result = await this.checkMessage(params, initialQualification);
      this.metrics?.record(result === 'allowed' ? 'guard.allowed' : 'guard.absent');
      return result;
    } catch (error) {
      if (error instanceof MessageDuplicateGuardRejectedError)
        this.metrics?.recordGuardRejection(error.code);
      else this.metrics?.record('guard.unavailable');
      throw error;
    }
  }

  async qualify(params: MessageDuplicateGuardInput): Promise<number | null> {
    await this.assertQualificationAuthority(params.chatId, params.binding);
    // FLAG: Resume the immutable stage after our own deletion; the sanction guard still
    // requires its exact durable receipt. Never reserve another stage on delivery retry.
    const qualified = await this.history.qualified(params.chatId, params.binding);
    if (qualified !== null) {
      if (!(await this.history.stillMatches(params.chatId, params.binding, true)))
        throw new MessageDuplicateGuardRejectedError('message_duplicate_history_changed');
      await this.assertAuthorization(params.chatId, params.binding);
      return qualified;
    }
    if ((await this.assertSourceActionable(params, true)) !== 'allowed') return null;
    await this.assertAuthorization(params.chatId, params.binding);
    return this.history.qualify(params.chatId, params.binding);
  }

  async assertQualificationAuthority(
    chatId: string,
    binding: MessageDuplicateBinding,
  ): Promise<void> {
    await this.assertAuthorization(chatId, binding);
    await this.assertPolicy(chatId, binding);
    await this.loadSettings(chatId, binding);
  }

  private async assertAuthorization(
    chatId: string,
    binding: MessageDuplicateBinding,
  ): Promise<void> {
    if (
      binding.version !== 3 ||
      !binding.lifecycleRevision ||
      !binding.original?.revision ||
      !binding.original.originalId ||
      !binding.authorization
    )
      throw new MessageDuplicateGuardRejectedError('message_duplicate_binding_invalid');
    await this.assertLegacySourcesAllowed(chatId, binding);
    if (!(await this.authorization.isAllowed(chatId, binding)))
      throw new MessageDuplicateGuardRejectedError('message_duplicate_action_revoked');
  }

  private async assertLegacySourcesAllowed(
    chatId: string,
    binding: MessageDuplicateBinding,
  ): Promise<void> {
    if (!binding.original)
      throw new MessageDuplicateGuardRejectedError('message_duplicate_binding_invalid');
    if (
      await this.legacyHolds?.isAnyMessageSourceHeld(chatId, [
        { messageId: binding.messageId, userId: binding.senderId },
        { messageId: binding.original.messageId, userId: binding.original.senderId },
      ])
    )
      throw new MessageDuplicateGuardRejectedError('message_duplicate_source_held');
  }

  private async checkMessage(
    params: MessageDuplicateGuardInput,
    initialQualification: boolean,
  ): Promise<'allowed' | 'absent'> {
    const { binding } = params;
    const notice = params.notice;
    const canonicalBinding = parseMessageDuplicateBinding({
      duplicateSource: MESSAGE_DUPLICATE_SOURCE,
      messageDuplicate: binding,
    });
    const canonicalNotice = notice ? readMessageDuplicateNoticeProof(notice) : null;
    if (
      notice &&
      (!canonicalNotice ||
        notice.chatId !== params.chatId ||
        JSON.stringify(canonicalNotice.binding) !== JSON.stringify(canonicalBinding) ||
        Date.now() >= notice.deadlineAtMs)
    )
      throw new MessageDuplicateGuardRejectedError('message_duplicate_notice_invalid');
    const receiptIntentId = notice?.intentId ?? params.sanctionIntentId;
    const noticeReceipt = notice
      ? await this.prisma.moderationDeleteIntent.findUnique({
          where: { id: notice.intentId },
          select: {
            chatId: true,
            messageId: true,
            subjectUserId: true,
            remoteDeleteSucceededAt: true,
            reasons: {
              where: { reasonKey: notice.reasonKey },
              select: { ruleCode: true, metadata: true, createdAt: true },
              take: 1,
            },
          },
        })
      : null;
    if (notice) {
      const reason = noticeReceipt?.reasons[0];
      const recorded = parseMessageDuplicateBinding(reason?.metadata);
      const metadata = reason?.metadata as Record<string, unknown> | null;
      if (
        noticeReceipt?.chatId !== params.chatId ||
        noticeReceipt.messageId !== params.messageId ||
        noticeReceipt.subjectUserId !== binding.senderId ||
        reason?.ruleCode !== 'DUPLICATE_DELETE' ||
        !recorded ||
        JSON.stringify(recorded) !== JSON.stringify(canonicalBinding) ||
        metadata?.count !== notice.stage.repeatCount
      )
        throw new MessageDuplicateGuardRejectedError('message_duplicate_notice_reason_changed');
    }
    await this.assertAuthorization(params.chatId, binding);
    if (!binding.original)
      throw new MessageDuplicateGuardRejectedError('message_duplicate_binding_invalid');
    if (
      params.subjectUserId !== binding.senderId ||
      params.messageId !== binding.messageId ||
      this.bots.isKnownBotUserId(binding.senderId)
    )
      throw new MessageDuplicateGuardRejectedError('message_duplicate_author_immune');
    await this.assertPolicy(params.chatId, binding, Boolean(params.sanctionIntentId));
    const settings = await this.loadSettings(params.chatId, binding, notice);
    const options = {
      botId: params.botId,
      timeoutMs: this.timeoutMs,
      bypassCache: true,
      trafficClass: 'critical' as const,
      actionHealthLane: 'critical' as const,
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      ignoreFailureMetricStatuses: MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
    };
    const access = await this.max.getChatMemberAccess(params.chatId, binding.senderId, options);
    // FLAG: Null is a valid uncached response without this member, not an unavailable MAX API.
    // Stop without sanctions; transport errors and malformed/mismatched responses still retry.
    if (!access)
      throw new MessageDuplicateGuardRejectedError('message_duplicate_author_not_member');
    if (access.userId !== binding.senderId)
      throw new Error('Message duplicate author access unavailable');
    if (access.isAdmin || access.isOwner)
      throw new MessageDuplicateGuardRejectedError('message_duplicate_author_immune');
    if (access.isAdmin !== false || access.isOwner !== false)
      throw new Error('Message duplicate author access unavailable');
    const raw = await this.lookupMessage(
      'current',
      params.chatId,
      params.messageId,
      options,
      initialQualification,
    );
    if (!raw && !receiptIntentId) return 'absent';
    if (!raw) {
      // FLAG: Absence alone cannot authorize a sanction. Require our exact successful DELETE
      // receipt and its immutable binding; an unrelated deletion or an ambiguous send is insufficient.
      const receipt =
        noticeReceipt ??
        (await this.prisma.moderationDeleteIntent.findUnique({
          where: { id: receiptIntentId },
          select: {
            chatId: true,
            messageId: true,
            subjectUserId: true,
            remoteDeleteSucceededAt: true,
            reasons: {
              where: { reasonKey: `MESSAGE_DUPLICATE:v1:${binding.eventTimestampMs}` },
              select: { metadata: true, createdAt: true },
              take: 1,
            },
          },
        }));
      const recorded = parseMessageDuplicateBinding(receipt?.reasons[0]?.metadata);
      const receiptMetadata = receipt?.reasons[0]?.metadata as Record<string, unknown> | null;
      if (
        !receipt?.remoteDeleteSucceededAt ||
        !receipt.reasons[0] ||
        receipt.reasons[0].createdAt > receipt.remoteDeleteSucceededAt ||
        receipt.chatId !== params.chatId ||
        receipt.messageId !== params.messageId ||
        receipt.subjectUserId !== binding.senderId ||
        receiptMetadata?.moderationDeleteVerified !== true ||
        !recorded ||
        recorded.contentDigest !== binding.contentDigest ||
        recorded.eventTimestampMs !== binding.eventTimestampMs ||
        recorded.controlRevision !== binding.controlRevision ||
        recorded.settingsDigest !== binding.settingsDigest ||
        recorded.version !== binding.version ||
        recorded.enforcementScope !== binding.enforcementScope ||
        recorded.lifecycleRevision !== binding.lifecycleRevision ||
        recorded.policyRevision !== binding.policyRevision ||
        JSON.stringify(recorded.authorization) !== JSON.stringify(binding.authorization) ||
        JSON.stringify(recorded.sanction) !== JSON.stringify(binding.sanction) ||
        JSON.stringify(recorded.original) !==
          JSON.stringify(messageDuplicateOriginalSchema.parse(binding.original))
      ) {
        throw new MessageDuplicateGuardRejectedError('message_duplicate_unproven_absence');
      }
    } else {
      const message = this.parser.parse({
        type: 'message_created',
        updateId: 'message-duplicate-guard',
        message: raw,
      }).message;
      if (
        !message ||
        message.chatId !== params.chatId ||
        message.messageId !== params.messageId ||
        message.senderId !== binding.senderId ||
        message.entityType === 'channel'
      ) {
        throw new MessageDuplicateGuardRejectedError('message_duplicate_identity_changed');
      }
      const content = extractDuplicateMessageContent(raw, false);
      if (
        (binding.compareMode === 'MESSAGE' && content.sourceDigest !== binding.sourceDigest) ||
        (binding.compareMode === 'IMAGE' &&
          exactImageSourceDigest(content) !== binding.sourceDigest) ||
        buildMessageDuplicateIdentity(content, binding.compareMode, binding.mediaHashes) !==
          binding.contentDigest
      ) {
        await this.history.invalidateLifecycle({
          chatId: params.chatId,
          messageId: params.messageId,
          content,
        });
        throw new MessageDuplicateGuardRejectedError('message_duplicate_content_changed');
      }
    }
    const originalRaw = await this.lookupMessage(
      'original',
      params.chatId,
      binding.original.messageId,
      options,
      initialQualification,
    );
    if (!originalRaw) {
      await this.history.remove(params.chatId, binding.original.messageId);
      throw new MessageDuplicateGuardRejectedError('message_duplicate_original_missing');
    }
    const originalMessage = this.parser.parse({
      type: 'message_created',
      updateId: 'message-duplicate-original-guard',
      message: originalRaw,
    }).message;
    const originalContent = extractDuplicateMessageContent(originalRaw, false);
    if (
      !originalMessage ||
      originalMessage.chatId !== params.chatId ||
      originalMessage.messageId !== binding.original.messageId ||
      originalMessage.senderId !== binding.original.senderId ||
      originalMessage.entityType === 'channel' ||
      duplicateSourceDigest(originalContent, binding.compareMode) !==
        binding.original.sourceDigest ||
      buildMessageDuplicateIdentity(
        originalContent,
        binding.compareMode,
        binding.original.mediaHashes,
      ) !== binding.original.contentDigest
    ) {
      // FLAG: A missed edit is not proof of removal. Revoke the observed evidence using its
      // actual current content; never manufacture a new publication or penalty from this read.
      await this.history.invalidateLifecycle({
        chatId: params.chatId,
        messageId: binding.original.messageId,
        content: originalContent,
      });
      throw new MessageDuplicateGuardRejectedError('message_duplicate_original_changed');
    }
    if (!(await this.history.stillMatches(params.chatId, binding, Boolean(receiptIntentId)))) {
      throw new MessageDuplicateGuardRejectedError('message_duplicate_history_changed');
    }
    await this.assertLegacySourcesAllowed(params.chatId, binding);
    const protection = await this.immunity.consumeForMessage({
      chatId: params.chatId,
      userId: binding.senderId,
      messageId: binding.messageId,
      scope: 'duplicate:v1',
      nightModeTimezone: settings.nightModeTimezone,
    });
    if (protection === 'granted')
      throw new MessageDuplicateGuardRejectedError('message_duplicate_author_immune');
    // FLAG: Re-read policy and settings after external/content checks, including queued intents.
    await params.beforeFinalAuthority?.();
    await this.loadSettings(params.chatId, binding, notice);
    await this.assertPolicy(params.chatId, binding, Boolean(params.sanctionIntentId));
    await this.assertAuthorization(params.chatId, binding);
    if (notice && Date.now() >= notice.deadlineAtMs)
      throw new MessageDuplicateGuardRejectedError('message_duplicate_notice_expired');
    // FLAG: The final SQL/Redis read may consume the original permit. Its success
    // cannot extend a member mutation or immediate sanction notice past either deadline.
    if (Date.now() >= Math.min(binding.authorization!.deadlineAtMs, binding.original.expiresAtMs))
      throw new MessageDuplicateGuardRejectedError('message_duplicate_action_expired');
    return 'allowed';
  }

  private async lookupMessage(
    stage: 'current' | 'original',
    chatId: string,
    messageId: string,
    options: Parameters<MaxClientService['getExactMessageRow']>[2],
    initialQualification: boolean,
  ): Promise<Record<string, unknown> | null> {
    let row: Record<string, unknown> | null;
    try {
      row = await this.max.getExactMessageRow(chatId, messageId, options);
    } catch (error) {
      // FLAG: Only a structured message-specific 404 proves absence. A bare 404,
      // access denial, proxy text or failed transport must preserve evidence. Only initial
      // qualification may decline an unavailable source after a separate unused-claim CAS;
      // final deletion/sanction guards retain the original failure and retry fences.
      if (!isConfirmedMessageAbsence(error)) {
        this.metrics?.record(
          stage === 'current'
            ? 'guard.current_lookup_unavailable'
            : 'guard.original_lookup_unavailable',
        );
        if (
          initialQualification &&
          extractHttpStatusCode(error) === 404 &&
          !wasMaxMessageSendAttempted(error) &&
          !wasMaxMemberMutationAttempted(error) &&
          !isMaxMutationOutcomeAmbiguous(error)
        )
          throw new MessageDuplicateQualificationSourceUnavailableError(stage, error);
        throw error;
      }
      row = null;
    }
    if (!row)
      this.metrics?.record(
        stage === 'current'
          ? 'guard.current_lookup_confirmed_absent'
          : 'guard.original_lookup_confirmed_absent',
      );
    return row;
  }

  private async assertPolicy(
    chatId: string,
    binding: MessageDuplicateBinding,
    requireFull = false,
  ): Promise<void> {
    const policy = await this.policy.resolve(chatId, true);
    if (
      (requireFull ? policy.mode !== 'full' : !['delete_only', 'full'].includes(policy.mode)) ||
      binding.version !== 3 ||
      (messageDuplicateEnforcementScope(binding) === 'full' && policy.mode !== 'full') ||
      (requireFull &&
        (messageDuplicateEnforcementScope(binding) !== 'full' || !binding.sanction)) ||
      policy.revision !== binding.controlRevision ||
      binding.eventTimestampMs < policy.effectiveAtMs ||
      !binding.original ||
      Date.now() >= binding.original.expiresAtMs ||
      binding.eventTimestampMs > Date.now() + 60_000
    ) {
      throw new MessageDuplicateGuardRejectedError('message_duplicate_policy_changed');
    }
    // FLAG: Retired whole-message photo bindings must not inherit new image-only authority.
    if (
      (binding.hasPhotos && binding.compareMode !== 'IMAGE') ||
      (binding.compareMode === 'IMAGE' &&
        (messageDuplicateEnforcementScope(binding) !== 'full' ||
          !binding.imageScope ||
          !binding.hasPhotos ||
          binding.photoControlRevision !== null))
    ) {
      throw new MessageDuplicateGuardRejectedError('message_duplicate_photo_policy_changed');
    }
  }

  private async loadSettings(
    chatId: string,
    binding: MessageDuplicateBinding,
    notice?: MessageDuplicateNoticeProof,
  ) {
    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId },
      include: { chat: { select: { entityType: true, admins: { select: { userId: true } } } } },
    });
    if (
      !settings?.antiDuplicateEnabled ||
      settings.chat.entityType !== 'CHAT' ||
      settings.duplicatePolicyRevision !== binding.policyRevision ||
      (binding.compareMode === 'IMAGE'
        ? exactImageSettingsDigest(settings)
        : messageDuplicateSettingsDigest(settings)) !== binding.settingsDigest ||
      (binding.compareMode === 'IMAGE' &&
        (settings.duplicateCompareMode === 'TEXT' ||
          settings.duplicatePhotoScope !== binding.imageScope)) ||
      resolveDuplicateFlowConfig(settings).allowedCount + 2 !== binding.requiredCount
    ) {
      throw new MessageDuplicateGuardRejectedError('message_duplicate_settings_changed');
    }
    if (notice) {
      const outcome = resolveDuplicateFlowOutcome({
        settings,
        repeatCount: notice.stage.repeatCount,
        hash: binding.fingerprint,
        fingerprintType: 'exact',
      });
      if (
        !settings.duplicateBotMessageEnabled ||
        messageDuplicateNoticeSettingsDigest(settings) !== notice.noticePolicySha256 ||
        (notice.stage.kind === 'hit'
          ? !outcome.hit || !!outcome.decision
          : outcome.decision?.action !== notice.stage.kind ||
            outcome.decision.threshold !== notice.stage.threshold)
      )
        throw new MessageDuplicateGuardRejectedError('message_duplicate_notice_settings_changed');
    }
    if (binding.sanction) {
      const decision = resolveDuplicateFlowOutcome({
        settings,
        repeatCount: binding.sanction.repeatCount,
        hash: binding.fingerprint,
        fingerprintType: 'exact',
      }).decision;
      if (
        messageDuplicateSanctionSettingsDigest(settings, binding.compareMode === 'IMAGE') !==
          binding.sanction.settingsDigest ||
        decision?.action !== binding.sanction.action ||
        decision.threshold !== binding.sanction.threshold
      ) {
        throw new MessageDuplicateGuardRejectedError('message_duplicate_sanction_settings_changed');
      }
    }
    const dailyWindow = resolveDuplicateDailyWindow(settings, binding.eventTimestampMs);
    if (
      !isDuplicateScheduleOpen(settings, binding.eventTimestampMs) ||
      (dailyWindow &&
        (!binding.original ||
          binding.original.publishedAtMs < dailyWindow.startMs ||
          binding.original.expiresAtMs !== dailyWindow.endMs))
    )
      throw new MessageDuplicateGuardRejectedError('message_duplicate_schedule_closed');
    if (settings.chat.admins.some((admin) => admin.userId === binding.senderId)) {
      throw new MessageDuplicateGuardRejectedError('message_duplicate_author_immune');
    }
    const release = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId,
        userId: binding.senderId,
        ruleCode: { in: ['MANUAL_UNMUTE', 'MANUAL_UNBAN'] },
        createdAt: {
          gte: new Date(dailyWindow?.startMs ?? Date.now() - binding.windowSeconds * 1000),
        },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (release) throw new MessageDuplicateGuardRejectedError('message_duplicate_manual_release');
    return settings;
  }
}

function isConfirmedMessageAbsence(error: unknown): boolean {
  const response = (error as { response?: { status?: unknown; data?: unknown } } | null | undefined)
    ?.response;
  if (response?.status !== 404) return false;
  const body = response.data;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const row = body as Record<string, unknown>;
  const nestedError =
    row.error && typeof row.error === 'object' && !Array.isArray(row.error)
      ? (row.error as Record<string, unknown>)
      : null;
  const code = nestedError?.code ?? row.code;
  return (
    typeof code === 'string' &&
    ['message.not.found', 'message_not_found', 'message.not_found'].includes(
      code.trim().toLowerCase(),
    )
  );
}
