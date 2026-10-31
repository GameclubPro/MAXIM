import { isDeepStrictEqual } from 'node:util';
import type { ChatSettings } from '../prisma/prisma-client';
import { withMarketplaceModerationMessage } from '../max/marketplace-publication-button';
import { buildMaxActionIdempotencyKey } from '../max/max-action-idempotency';
import { MAX_MEMBER_ACTION_PRE_DISPATCH_RETRY_ERROR_CODES } from '../max/max-action-ledger.service';
import { isMaxMembershipLookupLocalQuotaResolution } from '../max/max-membership-lookup.service';
import {
  wasMaxPreDispatchGuardRejected,
  withMaxFinalAuthorityCheckpoint,
} from '../max/max-action-pre-dispatch-guard';
import type { ModerationService } from './moderation.service';
import type { RequiredSubscriptionCandidateAttempt } from './required-subscription-candidate.contract';
import type { RequiredSubscriptionCandidateFreezeContext } from './required-subscription-candidate.store';
import {
  executeRequiredSubscriptionCandidateWorkflow,
  readRequiredSubscriptionCandidateSource,
  type FrozenRequiredSubscriptionCandidatePlan,
  type RequiredSubscriptionCandidateNoticeReceipt,
  type RequiredSubscriptionCandidateDeleteReceipt,
  type RequiredSubscriptionCandidateWorkflowDependencies,
  type RequiredSubscriptionCandidateWorkflowInput,
} from './required-subscription-candidate-workflow';
import {
  bindRequiredSubscriptionMediaNoticeScope,
  buildRequiredSubscriptionMediaNoticeCoverageId,
  isRequiredSubscriptionMediaNoticeStateCovering,
  RequiredSubscriptionMediaNoticeCoverageStore,
  type RequiredSubscriptionMediaNoticeScope,
} from './required-subscription-media-notice';
import {
  buildRequiredSubscriptionNoticePlan,
  type RequiredSubscriptionNoticePlan,
} from './required-subscription-notice-plan';
import {
  readRequiredSubscriptionNoticeAuthority,
  RequiredSubscriptionNoticeNotDispatchedError,
  type RequiredSubscriptionNoticeAuthority,
} from './required-subscription-notice-authority';
import {
  RequiredSubscriptionExecutionRejectedError,
  RequiredSubscriptionMembershipUnavailableError,
  RequiredSubscriptionInitialSourceUnavailableError,
  RequiredSubscriptionDeleteSourceUnavailableError,
  readRequiredSubscriptionInitialSourceReadWait,
} from './required-subscription-execution-guard.service';
import { createRequiredSubscriptionNoticeHandoff } from './moderation-execution-guard-callbacks';
import { fingerprintModerationSettings } from './moderation-settings-fingerprint';
import { maskText } from './text-mask.util';

type Host = ReturnType<ModerationService['getRequiredSubscriptionCandidateHost']>;
type Qualification = Awaited<
  ReturnType<RequiredSubscriptionCandidateWorkflowDependencies['qualify']>
>;
type NoticeReceipt = RequiredSubscriptionCandidateNoticeReceipt;
type DeleteReceipt = RequiredSubscriptionCandidateDeleteReceipt;
type NoticeObservation =
  | { kind: 'committed'; receipt: NoticeReceipt }
  | { kind: 'retry_read' }
  | { kind: 'effect_unknown' };
class CandidateNoticeEffectUnknownError extends Error {}
const REASON_KEY = 'REQUIRED_SUBSCRIPTION:message-delete' as const;
const DELETE_STATUSES = new Set([
  'PENDING',
  'IN_PROGRESS',
  'RETRYABLE',
  'WAITING_CAPABILITY',
  'SUCCEEDED',
  'ALREADY_ABSENT',
]);

export async function nominateRequiredSubscriptionCandidate(
  host: Host,
  params: {
    chatId: string;
    userId: string;
    messageId: string;
    userLabel: string;
    text: string;
    createdAt: string;
    settings: object;
    rulesPublishedUrl: string | null;
    rulesPublishedMessageId: string | null;
    sourceUpdateType?: string | null;
    suppressEscalation?: boolean;
    mediaNoticeScope?: RequiredSubscriptionMediaNoticeScope | null;
    localQuotaResolution?: unknown;
    sourceReadFailure?: unknown;
    assertLeaseOwned?: () => Promise<void>;
  },
): Promise<boolean> {
  // FLAG: A candidate is only an obligation to recheck this exact GET's uncertainty.
  // Active-mute suppression needs its own SQL receipt and is outside this admission path.
  if (params.suppressEscalation) return false;
  const sourceAtMs = Date.parse(params.createdAt);
  const policySha256 = fingerprintModerationSettings(params.settings, 'REQUIRED_SUBSCRIPTION');
  const originBotId = host.botContext?.getActiveBotId() ?? null;
  const initialReadWait = readRequiredSubscriptionInitialSourceReadWait(params.sourceReadFailure, {
    chatId: params.chatId,
    userId: params.userId,
    messageId: params.messageId,
    sourceAtMs,
    deadlineAtMs: sourceAtMs + 300_000,
    policySha256,
    botId: originBotId ?? '',
  });
  if (!initialReadWait && !isMaxMembershipLookupLocalQuotaResolution(params.localQuotaResolution))
    return false;
  const source = readRequiredSubscriptionCandidateSource({
    version: 1,
    chatId: params.chatId,
    userId: params.userId,
    messageId: params.messageId,
    sourceAtMs,
    deadlineAtMs: sourceAtMs + 300_000,
    policySha256,
    originBotId,
    updateType: params.sourceUpdateType,
    mediaScope: params.mediaNoticeScope ?? null,
    userLabel: params.userLabel,
    maskedExcerpt: maskText(params.text).slice(0, 8_192),
    rulesPublishedUrl: params.rulesPublishedUrl,
    rulesPublishedMessageId: params.rulesPublishedMessageId,
  });
  if (!source || source.sourceAtMs > Date.now() || Date.now() >= source.deadlineAtMs) return false;
  // FLAG: A certified live initial read cannot become handled without its durable owner.
  // The coordinator lease fences only this registration; it never grants an external effect.
  if (!host.store) {
    if (initialReadWait) throw new Error('Required subscription candidate store unavailable');
    return false;
  }
  await params.assertLeaseOwned?.();
  await host.store.register(source);
  await params.assertLeaseOwned?.();
  return true;
}

export async function executeRequiredSubscriptionCandidate(
  host: Host,
  attempt: RequiredSubscriptionCandidateAttempt,
): Promise<void> {
  const { row, store, journal } = attempt;
  const token = row.leaseToken;
  if (!token || !host.guard || !host.deleteIntents)
    throw new Error('Required subscription candidate executor unavailable');
  const source = row.source;
  let ownedPlan = row.frozenPlan;
  const baseReceipt = {
    candidateId: row.id,
    chatId: source.chatId,
    userId: source.userId,
    messageId: source.messageId,
    sourceAtMs: source.sourceAtMs,
    deadlineAtMs: source.deadlineAtMs,
    policySha256: source.policySha256,
  };
  const assertCandidate = () => store.assertLease(row.id, token);
  const proof: RequiredSubscriptionNoticeAuthority = {
    version: 1,
    chatId: source.chatId,
    userId: source.userId,
    messageId: source.messageId,
    sourceAtMs: source.sourceAtMs,
    deadlineAtMs: source.deadlineAtMs,
    policySha256: source.policySha256,
    reasonKey: REASON_KEY,
  };
  const metadata = {
    requiredSubscriptionGuardVersion: 1,
    requiredSubscriptionPolicySha256: source.policySha256,
    requiredSubscriptionSourceAtMs: source.sourceAtMs,
    requiredSubscriptionDeadlineAtMs: source.deadlineAtMs,
  };
  const guard = host.guard;
  const authorize = async (
    initial = false,
    deleteHandoff = false,
    beforeFinalAuthority?: () => Promise<void>,
    selectedExecutor = false,
  ) => {
    await assertCandidate();
    if (await host.held(source.chatId, source.userId, source.messageId))
      throw new RequiredSubscriptionExecutionRejectedError();
    const permit = await guard.authorize({
      chatId: source.chatId,
      messageId: source.messageId,
      subjectUserId: source.userId,
      // FLAG: Ingress identity is historical. Final mutation callbacks use their
      // selected executor; preparation lets the public guard choose a current route.
      botId: selectedExecutor ? (host.botContext?.getActiveBotId() ?? undefined) : undefined,
      ...(initial ? { initialQualification: true } : {}),
      ...(deleteHandoff ? { deleteHandoffQualification: true } : {}),
      beforeFinalAuthority,
      reasons: [{ ruleCode: 'REQUIRED_SUBSCRIPTION_DELETE', reasonKey: REASON_KEY, metadata }],
    });
    if (typeof permit !== 'object') throw new RequiredSubscriptionExecutionRejectedError();
  };
  const loadSettings = async (): Promise<ChatSettings | null> => {
    const settings = await host.prisma.chatSettings.findUnique({
      where: { chatId: source.chatId },
    });
    return settings?.requiredSubscriptionEnabled &&
      fingerprintModerationSettings(settings, 'REQUIRED_SUBSCRIPTION') === source.policySha256
      ? settings
      : null;
  };
  const qualify = async (): Promise<Qualification> => {
    const settings = await loadSettings();
    if (!settings) return { kind: 'not_actionable', reason: 'policy' };
    const requiredChannelIds = host.readChannelIds(settings.requiredSubscriptionChannelIds);
    if (!requiredChannelIds.length) return { kind: 'not_actionable', reason: 'targets' };
    const results: Array<{
      channelId: string;
      membership: boolean | null;
      fresh: boolean;
      terminal: boolean;
    }> = [];
    for (let offset = 0; offset < requiredChannelIds.length; offset += 2) {
      await assertCandidate();
      results.push(
        ...(await Promise.all(
          requiredChannelIds.slice(offset, offset + 2).map(async (channelId) => ({
            channelId,
            ...(await host.membership(channelId, source.userId, {
              forceFresh: true,
              allowStaleOnError: false,
            })),
          })),
        )),
      );
    }
    if (results.some((result) => result.terminal))
      return { kind: 'not_actionable', reason: 'target_access' };
    if (results.some((result) => !result.fresh || result.membership === null))
      return { kind: 'retry_read' };
    const missingChannelIds = results
      .filter((result) => result.membership === false)
      .map((result) => result.channelId);
    if (!missingChannelIds.length) return { kind: 'not_actionable', reason: 'subscribed' };
    try {
      await authorize(true);
    } catch (error) {
      if (error instanceof RequiredSubscriptionExecutionRejectedError)
        return { kind: 'not_actionable', reason: 'authority' };
      if (
        error instanceof RequiredSubscriptionMembershipUnavailableError ||
        error instanceof RequiredSubscriptionInitialSourceUnavailableError
      )
        return { kind: 'retry_read' };
      throw error;
    }
    return { kind: 'qualified', qualification: { requiredChannelIds, missingChannelIds } };
  };

  const noticeLedger = async (noticeKey: string, expected: RequiredSubscriptionNoticeAuthority) => {
    const keys = [
      buildMaxActionIdempotencyKey('explicit', ['SEND_MESSAGE', noticeKey]),
      ...(source.originBotId
        ? [
            buildMaxActionIdempotencyKey('explicit', [
              source.originBotId,
              'SEND_MESSAGE',
              noticeKey,
            ]),
          ]
        : []),
    ];
    const rows = await host.prisma.maxActionLedgerEntry.findMany({
      where: { jobId: { in: keys } },
      take: 2,
    });
    for (const entry of rows) {
      const bound = readRequiredSubscriptionNoticeAuthority(
        record(record(entry.metadata).ledgerContext).requiredSubscriptionNotice,
      );
      if (
        entry.actionType !== 'SEND_MESSAGE' ||
        entry.chatId !== source.chatId ||
        !bound ||
        !isDeepStrictEqual(bound, expected)
      )
        continue;
      // FLAG: Ambiguous queue ownership can predate an enqueuedAt receipt. The exact
      // serialized source still fences SEND; missing handoff time cannot authorize replay.
      if (entry.ambiguous || entry.status === 'AMBIGUOUS')
        return { kind: 'effect_unknown' } as const;
      if (!entry.enqueuedAt || entry.enqueuedAt.getTime() >= expected.deadlineAtMs) continue;
      if (['ENQUEUED', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED_RETRYABLE'].includes(entry.status))
        return { kind: 'committed', id: entry.id } as const;
    }
    return { kind: 'retry_read' } as const;
  };
  const ownNotice = async (
    plan: FrozenRequiredSubscriptionCandidatePlan,
  ): Promise<NoticeObservation> => {
    const ledger = await noticeLedger(plan.sanction.noticeKey, plan.notice.executionProof);
    if (ledger.kind !== 'committed') return ledger;
    return {
      kind: 'committed',
      receipt: {
        ...baseReceipt,
        kind: 'notice_handoff',
        noticeKey: plan.sanction.noticeKey,
        receiptId: ledger.id,
      },
    };
  };
  const coverageStore = new RequiredSubscriptionMediaNoticeCoverageStore(
    host.prisma.moderationEvent,
  );
  let mediaScope: RequiredSubscriptionMediaNoticeScope | null = null;
  const coveredNotice = async (): Promise<NoticeObservation> => {
    const saved = record(row.effects.notice);
    // FLAG: Receipt-only recovery uses the exact coverage receipt validated before
    // DELETE transfer. It neither reconstructs qualification nor borrows anchor time.
    const savedCoverage =
      source.mediaScope &&
      saved.kind === 'media_coverage' &&
      Object.entries(baseReceipt).every(([key, value]) => saved[key] === value)
        ? saved
        : null;
    if (!mediaScope && !savedCoverage) return { kind: 'retry_read' };
    const coverageId = buildRequiredSubscriptionMediaNoticeCoverageId(
      source.chatId,
      source.messageId,
    );
    const entry = await host.prisma.moderationEvent.findUnique({ where: { id: coverageId } });
    if (
      !entry ||
      entry.chatId !== source.chatId ||
      entry.userId !== source.userId ||
      entry.messageId !== source.messageId
    )
      return { kind: 'retry_read' };
    const coverage = await coverageStore.read(source.chatId, source.messageId);
    if (
      !coverage ||
      (mediaScope
        ? !isRequiredSubscriptionMediaNoticeStateCovering(coverage, mediaScope)
        : savedCoverage?.receiptId !== coverageId ||
          savedCoverage.noticeKey !== coverage.noticeIdempotencyKey)
    )
      return { kind: 'retry_read' };
    const anchor = await host.noticePlans.read(source.chatId, coverage.anchorMessageId);
    const anchorProof = readRequiredSubscriptionNoticeAuthority(anchor?.executionProof);
    if (
      !anchorProof ||
      anchorProof.chatId !== source.chatId ||
      anchorProof.userId !== source.userId ||
      anchorProof.messageId !== coverage.anchorMessageId ||
      anchorProof.sourceAtMs !== coverage.anchorSourceCreatedAtMs ||
      anchorProof.policySha256 !== source.policySha256
    )
      return { kind: 'retry_read' };
    const ledger = await noticeLedger(coverage.noticeIdempotencyKey, anchorProof);
    if (ledger.kind !== 'committed') return ledger;
    return {
      kind: 'committed',
      receipt: {
        ...baseReceipt,
        kind: 'media_coverage',
        noticeKey: coverage.noticeIdempotencyKey,
        receiptId: coverageId,
      },
    };
  };
  const existingDelete = async (notice: NoticeReceipt): Promise<DeleteReceipt | null> => {
    const intent = await host.prisma.moderationDeleteIntent.findUnique({
      where: { chatId_messageId: { chatId: source.chatId, messageId: source.messageId } },
    });
    if (
      !intent ||
      intent.subjectUserId !== source.userId ||
      intent.sourceMessageAt?.getTime() !== source.sourceAtMs ||
      intent.createdAt.getTime() >= source.deadlineAtMs ||
      !DELETE_STATUSES.has(intent.status)
    )
      return null;
    const reason = await host.prisma.moderationDeleteIntentReason.findUnique({
      where: { intentId_reasonKey: { intentId: intent.id, reasonKey: REASON_KEY } },
    });
    const bound = record(reason?.metadata);
    if (
      !reason ||
      reason.ruleCode !== 'REQUIRED_SUBSCRIPTION_DELETE' ||
      reason.userId !== source.userId ||
      reason.createdAt.getTime() >= source.deadlineAtMs ||
      Object.entries(metadata).some(([key, value]) => bound[key] !== value)
    )
      return null;
    if (notice.candidateId !== row.id) return null;
    return {
      ...baseReceipt,
      intentId: intent.id,
      reasonKey: REASON_KEY,
      rollout: 'execute',
      status: intent.status as DeleteReceipt['status'],
    };
  };
  let settled = false;
  const settle: RequiredSubscriptionCandidateWorkflowDependencies['settle'] = async (outcome) => {
    const status =
      outcome.kind === 'delete_transferred'
        ? 'DONE'
        : outcome.kind === 'expired'
          ? 'EXPIRED'
          : outcome.kind === 'effect_unknown'
            ? 'UNKNOWN'
            : outcome.kind === 'retry_read'
              ? 'WAITING_CHECK'
              : 'NO_ACTION';
    await store.finish(
      row.id,
      token,
      status,
      `REQUIRED_SUBSCRIPTION_${outcome.kind.toUpperCase()}`,
      outcome.kind === 'retry_read' ? Math.min(outcome.retryAfterMs ?? 1_000, 60_000) : 1_000,
    );
    settled = true;
  };
  let preliminary: Qualification = row.frozenPlan
    ? { kind: 'qualified', qualification: row.frozenPlan.qualification }
    : { kind: 'retry_read' };
  if (Date.now() < source.deadlineAtMs && !row.frozenPlan) preliminary = await qualify();
  if (preliminary.kind === 'qualified' && source.mediaScope)
    mediaScope = bindRequiredSubscriptionMediaNoticeScope({
      scope: source.mediaScope,
      requiredChannelIds: preliminary.qualification.requiredChannelIds,
      missingChannelIds: preliminary.qualification.missingChannelIds,
    });

  // FLAG: A committed handoff can settle after expiry; it grants no fresh SEND/DELETE.
  // Candidate-owned decision or exact follower coverage must also bind the prior notice.
  if (Date.now() >= source.deadlineAtMs) {
    const notice = row.frozenPlan ? await ownNotice(row.frozenPlan) : await coveredNotice();
    if (notice.kind === 'effect_unknown') {
      await settle({ kind: 'effect_unknown', effect: 'notice' });
      return;
    }
    const receipt = notice.kind === 'committed' ? await existingDelete(notice.receipt) : null;
    if (receipt) {
      await store.recordReceipt(row.id, token, 'delete', receipt);
      await store.finish(row.id, token, 'DONE');
      return;
    }
  }

  let preparedVariants: Map<string, RequiredSubscriptionNoticePlan> | null = null;
  const prepareVariants = async (
    qualification: Extract<Qualification, { kind: 'qualified' }>['qualification'],
  ) => {
    const settings = await loadSettings();
    if (!settings) throw new RequiredSubscriptionExecutionRejectedError();
    const channels = await host.channels(qualification.missingChannelIds, {
      allowRemoteFetch: true,
    });
    const titles = channels.map((channel) => host.channelTitle(channel.id, channel.title));
    const options =
      host.options(
        channels,
        settings.requiredSubscriptionButtonText,
        settings.rulesAttachViolationsEnabled,
        source.rulesPublishedUrl,
        source.rulesPublishedMessageId,
      ) ?? undefined;
    const label = await host.userLabel(source.chatId, source.userId, source.userLabel);
    const copy = {
      explanation: () =>
        host.adminContact(
          source.chatId,
          host.explanation(
            source.userLabel,
            null,
            titles,
            settings.requiredSubscriptionBotMessageText,
            settings.botSpeechStyle,
          ),
          settings.requiredSubscriptionAdminContactButtonEnabled,
          settings.requiredSubscriptionAdminContactButtonUrl,
        ),
      warning: () =>
        host.adminContact(
          source.chatId,
          host.warning(
            source.userLabel,
            titles,
            settings.requiredSubscriptionWarnMessageText,
            settings.botSpeechStyle,
          ),
          settings.requiredSubscriptionAdminContactButtonEnabled,
          settings.requiredSubscriptionAdminContactButtonUrl,
        ),
      mute: () =>
        host.mute(
          label,
          titles,
          settings.botSpeechStyle,
          settings.requiredSubscriptionMuteDurationHours,
        ),
      ban: () =>
        host.ban(
          label,
          titles,
          settings.requiredSubscriptionMuteDurationHours,
          settings.botSpeechStyle,
        ),
    };
    const variants = new Map<string, RequiredSubscriptionNoticePlan>();
    for (const action of ['NONE', 'WARN', 'MUTE', 'BAN'] as const)
      variants.set(
        action,
        await buildRequiredSubscriptionNoticePlan({
          action,
          executionProof: proof,
          baseMessageOptions: options,
          sanctionEventId: `${row.id}:decision`,
          deleteBotMessagesEnabled: settings.deleteBotMessagesEnabled,
          deleteBotMessagesDelayMinutes: settings.deleteBotMessagesDelayMinutes,
          copy,
        }),
      );
    return variants;
  };
  const freezePlan = (
    context: RequiredSubscriptionCandidateFreezeContext,
  ): FrozenRequiredSubscriptionCandidatePlan => {
    const settings = context.settings;
    const action = host.escalation(context.violationCount24h, {
      warnEnabled: settings.requiredSubscriptionWarnEnabled,
      banEnabled: settings.requiredSubscriptionBanEnabled,
      muteEnabled: settings.requiredSubscriptionMuteEnabled,
    });
    const notice = preparedVariants?.get(action);
    if (!notice?.executionProof)
      throw new Error('Required subscription candidate notice variants unavailable');
    return {
      version: 1,
      candidateId: row.id,
      source,
      qualification: context.qualification,
      violationCount24h: context.violationCount24h,
      sanction: {
        action,
        issuedAtMs: context.issuedAtMs,
        muteDurationHours: settings.requiredSubscriptionMuteDurationHours,
        muteExpiresAtMs:
          action === 'MUTE'
            ? context.issuedAtMs + settings.requiredSubscriptionMuteDurationHours * 3_600_000
            : null,
        eventId: context.eventId,
        noticeKey: `required-subscription:notice:v1:${source.chatId}:${source.messageId}`,
      },
      notice: { ...notice, executionProof: notice.executionProof },
    };
  };
  let observedNotice: NoticeReceipt | null = null;
  let leading = false;
  const execute = async (
    input: RequiredSubscriptionCandidateWorkflowInput,
    assertNotice: () => Promise<void>,
    handoff?: (plan: RequiredSubscriptionNoticePlan) => Promise<void>,
  ) =>
    host.sanctionLock.runExclusive(source, async (lock) => {
      const assertOwned = async () => {
        await assertCandidate();
        await assertNotice();
        await lock.assertOwned();
      };
      const recoverBanReceipt = async () => {
        const ledger = await host.prisma.maxActionLedgerEntry.findUnique({
          where: { jobId: host.max.getExplicitActionJobId('BAN_MEMBER', `${row.id}:sanction-ban`) },
        });
        if (
          !ledger ||
          ledger.actionType !== 'BAN_MEMBER' ||
          ledger.chatId !== source.chatId ||
          ledger.userId !== source.userId
        )
          return { kind: 'unknown' } as const;
        if (ledger.status === 'SUCCEEDED' && !ledger.ambiguous && ledger.completedAt)
          return { kind: 'confirmed', botId: ledger.dispatchBotId ?? ledger.botId } as const;
        if (
          !ledger.ambiguous &&
          !ledger.dispatchStartedAt &&
          ledger.lastErrorCode &&
          MAX_MEMBER_ACTION_PRE_DISPATCH_RETRY_ERROR_CODES.includes(ledger.lastErrorCode as never)
        )
          return { kind: 'no_effect' } as const;
        return { kind: 'unknown' } as const;
      };
      return executeRequiredSubscriptionCandidateWorkflow(input, {
        now: Date.now,
        assertOwned,
        sanctionJournal: journal,
        qualify: async () => {
          if (preliminary.kind !== 'qualified') return preliminary;
          try {
            await authorize(true, false, assertOwned);
          } catch (error) {
            if (error instanceof RequiredSubscriptionExecutionRejectedError)
              return { kind: 'not_actionable', reason: 'authority' };
            if (
              error instanceof RequiredSubscriptionMembershipUnavailableError ||
              error instanceof RequiredSubscriptionInitialSourceUnavailableError
            )
              return { kind: 'retry_read' };
            throw error;
          }
          preparedVariants = await prepareVariants(preliminary.qualification);
          return preliminary;
        },
        freezeOwnClaimAndDecision: async ({ qualification }) => {
          const frozen = await store.freezeOwnClaimAndDecision({
            id: row.id,
            leaseToken: token,
            qualification,
            buildPlan: freezePlan,
          });
          if (frozen.kind === 'owned') ownedPlan = frozen.plan;
          return frozen;
        },
        sanctionDependencies: (plan) => ({
          authorize: async () => {
            await assertOwned();
            const release = await host.manualRelease(source.chatId, source.userId);
            if (release && release.getTime() >= plan.sanction.issuedAtMs) return false;
            try {
              await authorize(false, false, assertOwned);
              return true;
            } catch (error) {
              if (error instanceof RequiredSubscriptionExecutionRejectedError) return false;
              throw error;
            }
          },
          ban: async ({ actionKey, beforeMutation }) => {
            try {
              const result = await host.banImmediately(
                source.chatId,
                source.userId,
                {
                  idempotencyKey: actionKey,
                  beforeImmediateMemberMutation: withMaxFinalAuthorityCheckpoint(
                    async (beforeFinalAuthority) => {
                      await beforeMutation();
                      await authorize(
                        false,
                        false,
                        async () => {
                          await assertOwned();
                          await beforeFinalAuthority?.();
                        },
                        true,
                      );
                    },
                  ),
                },
                { assertOwned },
              );
              return result.ok ? { kind: 'confirmed', botId: result.botId } : recoverBanReceipt();
            } catch (error) {
              if (wasMaxPreDispatchGuardRejected(error)) return { kind: 'no_effect' };
              return recoverBanReceipt();
            }
          },
          recoverBanReceipt,
          persistDeterministicEvent: async () =>
            (await store.persistDeterministicEvent({ id: row.id, leaseToken: token, metadata })).id,
          rememberActiveMute: async () => {
            await host.activeMute(source.chatId, source.userId, plan.sanction.muteDurationHours, {
              bypassCache: true,
            });
          },
          rememberInactiveMute: async () => {
            await host.activeMute(source.chatId, source.userId, plan.sanction.muteDurationHours, {
              bypassCache: true,
            });
          },
        }),
        handoffNotice: async (plan) => {
          const existing = observedNotice
            ? { kind: 'committed' as const, receipt: observedNotice }
            : await ownNotice(plan);
          if (existing.kind === 'effect_unknown') return existing;
          if (existing.kind === 'committed') {
            await store.recordReceipt(row.id, token, 'notice', existing.receipt);
            return existing;
          }
          if (!handoff) return { kind: 'retry_read' };
          const release = await host.manualRelease(source.chatId, source.userId);
          if (release && release.getTime() >= plan.sanction.issuedAtMs)
            return { kind: 'revoked', reason: 'manual_release' };
          const durable = await host.noticePlans.persist({
            chatId: source.chatId,
            userId: source.userId,
            messageId: source.messageId,
            botId: source.originBotId,
            plan: plan.notice,
          });
          if (!isDeepStrictEqual(durable, plan.notice))
            throw new Error('Required subscription candidate notice plan conflict');
          try {
            await handoff(durable);
          } catch (error) {
            if (error instanceof RequiredSubscriptionNoticeNotDispatchedError)
              return { kind: 'revoked', reason: 'notice_authority' };
            throw error;
          }
          const receipt = await ownNotice(plan);
          if (receipt.kind !== 'committed') return receipt;
          await store.recordReceipt(row.id, token, 'notice', receipt.receipt);
          return receipt;
        },
        handoffDelete: async (_source, notice) => {
          await assertOwned();
          const existing = await existingDelete(notice);
          if (existing) {
            await store.recordReceipt(row.id, token, 'delete', existing);
            return { kind: 'committed', receipt: existing };
          }
          try {
            await authorize(false, true, assertOwned);
          } catch (error) {
            if (error instanceof RequiredSubscriptionExecutionRejectedError)
              return { kind: 'revoked', reason: 'delete_authority' };
            if (
              !(error instanceof RequiredSubscriptionMembershipUnavailableError) &&
              !(error instanceof RequiredSubscriptionDeleteSourceUnavailableError)
            )
              throw error;
          }
          await assertOwned();
          const result = await host.deleteIntents!.ensureIntent(
            host.prepareDelete({
              chatId: source.chatId,
              messageId: source.messageId,
              subjectUserId: source.userId,
              sourceMessageAt: new Date(source.sourceAtMs),
              retryUntilAt: new Date(source.deadlineAtMs),
              originBotId: source.originBotId,
              entityType: 'CHAT',
              messageAuthorKind: 'user',
              reasonKey: REASON_KEY,
              ruleCode: 'REQUIRED_SUBSCRIPTION_DELETE',
              event: {
                userId: source.userId,
                eventType: 'MESSAGE',
                score: 1,
                maskedExcerpt: source.maskedExcerpt,
                metadata: { action: 'DELETE_MESSAGE', ...metadata },
              },
            }),
          );
          if (
            result.rollout !== 'execute' ||
            !result.intentId ||
            !result.status ||
            !DELETE_STATUSES.has(result.status)
          )
            return { kind: 'retry_read' };
          const receipt = await existingDelete(notice);
          if (!receipt || receipt.intentId !== result.intentId) return { kind: 'retry_read' };
          await store.recordReceipt(row.id, token, 'delete', receipt);
          return { kind: 'committed', receipt };
        },
        settle,
      });
    });
  if (preliminary.kind !== 'qualified' || Date.now() >= source.deadlineAtMs) {
    await execute(
      { candidateId: row.id, source, frozenPlan: row.frozenPlan },
      async () => undefined,
    );
    return;
  }
  let noticeRevoked = false;
  await host.coordinator
    .run({
      chatId: source.chatId,
      userId: source.userId,
      messageId: source.messageId,
      botId: source.originBotId,
      mediaScope,
      // FLAG: Only an owned decision can recover this message's persisted notice plan.
      // Package anchors retain their own proof; followers never enter leader qualification.
      readNoticePlan: (messageId) =>
        messageId === source.messageId && !ownedPlan
          ? Promise.resolve(null)
          : host.noticePlans.read(source.chatId, messageId),
      handoffNoticePlan: async (plan: RequiredSubscriptionNoticePlan, key, assertNotice) => {
        const expected = readRequiredSubscriptionNoticeAuthority(plan.executionProof);
        if (!expected) throw new Error('Required subscription candidate notice proof unavailable');
        const receipt = await noticeLedger(key, expected);
        if (receipt.kind === 'effect_unknown') throw new CandidateNoticeEffectUnknownError();
        if (receipt.kind === 'committed') {
          if (ownedPlan && expected.messageId === source.messageId)
            observedNotice = {
              ...baseReceipt,
              kind: 'notice_handoff',
              noticeKey: key,
              receiptId: receipt.id,
            };
          return;
        }
        if (
          expected.messageId === source.messageId &&
          (!ownedPlan || !isDeepStrictEqual(plan, ownedPlan.notice))
        )
          throw new Error('Required subscription candidate notice ownership mismatch');
        const settings = await loadSettings();
        if (!settings) throw new RequiredSubscriptionExecutionRejectedError();
        const send = createRequiredSubscriptionNoticeHandoff(
          guard,
          () => host.botContext?.getActiveBotId() ?? undefined,
          source,
          async ({ mediaFieldKey, ...notice }) =>
            host.send({
              ...notice,
              messageOptions: withMarketplaceModerationMessage(
                notice.messageOptions,
                source.chatId,
                'MODERATION_NOTICE',
                'REQUIRED_SUBSCRIPTION',
              ),
              media: host.media(settings, mediaFieldKey ?? undefined),
            }),
        );
        try {
          await send(plan, key, async () => {
            await assertCandidate();
            await assertNotice();
            if (ownedPlan && expected.messageId === source.messageId) {
              const release = await host.manualRelease(source.chatId, source.userId);
              if (release && release.getTime() >= ownedPlan.sanction.issuedAtMs)
                throw new RequiredSubscriptionNoticeNotDispatchedError(
                  'Required subscription sanction manually released',
                );
            }
          });
        } catch (error) {
          if (error instanceof RequiredSubscriptionNoticeNotDispatchedError) noticeRevoked = true;
          throw error;
        }
        if (ownedPlan && plan.executionProof?.messageId === source.messageId) {
          const observed = await ownNotice(ownedPlan);
          if (observed.kind === 'effect_unknown') throw new CandidateNoticeEffectUnknownError();
          if (observed.kind === 'committed') observedNotice = observed.receipt;
        }
      },
      executeDelete: async (assertNotice) => {
        if (leading) return;
        let observation: NoticeObservation = observedNotice
          ? { kind: 'committed', receipt: observedNotice }
          : ownedPlan
            ? await ownNotice(ownedPlan)
            : { kind: 'retry_read' };
        if (observation.kind === 'retry_read') observation = await coveredNotice();
        if (observation.kind === 'effect_unknown') throw new CandidateNoticeEffectUnknownError();
        if (observation.kind !== 'committed')
          throw new Error('Required subscription candidate notice receipt unavailable');
        const notice = observation.receipt;
        await store.recordReceipt(row.id, token, 'notice', notice);
        if (notice.kind === 'media_coverage')
          await execute(
            { candidateId: row.id, source, noticeReceipt: { ...notice, kind: 'media_coverage' } },
            assertNotice,
          );
        else await execute({ candidateId: row.id, source, frozenPlan: ownedPlan }, assertNotice);
      },
      lead: async ({ assertOwned, settleNoticePlan }) => {
        leading = true;
        try {
          await execute(
            { candidateId: row.id, source, frozenPlan: row.frozenPlan },
            assertOwned,
            settleNoticePlan,
          );
          return true;
        } finally {
          leading = false;
        }
      },
    })
    .catch(async (error: unknown) => {
      if (!(error instanceof CandidateNoticeEffectUnknownError)) throw error;
      await settle({ kind: 'effect_unknown', effect: 'notice' });
    });
  if (noticeRevoked && !settled)
    await settle({ kind: 'not_actionable', reason: 'notice_authority' });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
