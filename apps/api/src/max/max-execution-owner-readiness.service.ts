import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ChatEntityType } from '../prisma/prisma-client';
import { WebhookPreparationDeferredError } from '../common/webhook-preparation-deferred.error';
import { WebhookExecutionOwnerUnavailableError } from '../common/webhook-execution-owner-unavailable.error';
import { RedisCounterService } from '../moderation/redis-counter.service';
import { MaxBotLinkService } from './max-bot-link.service';
import { normalizeMembershipAccessSnapshot } from './max-bot-access-policy.util';
import { isMajorManagedEntityActivationRequired } from './managed-entity-activation.util';
import { MAX_API_SOURCE_TAGS, MaxClientService } from './max-client.service';
import {
  executionRouteProof,
  hasExecutionCapability,
  hasFreshExecutionAccess,
  type MaxExecutionAccessEpoch,
  type MaxExecutionPurpose,
  type MaxExecutionRouteProof,
} from './max-execution-route-proof';

const PROBE_LEASE_MS = 30_000;
const NEGATIVE_PROBE_RECHECK_MS = 15_000;
const PROBE_SOURCE = 'moderation_executor_readiness';
const WAIT_LOG_INTERVAL_MS = 30_000;
const DEFERRED_REASONS = new Map([
  ['Execution owner probe already active', 'probe_busy'],
  ['Execution owner probe lease lost', 'probe_lease_lost'],
  ['Execution access probe superseded', 'access_probe_superseded'],
  ['Execution denial probe superseded', 'denial_probe_superseded'],
  ['Current execution owner probe pending', 'owner_probe_pending'],
  ['Current execution owner permissions unknown', 'owner_permissions_unknown'],
  ['Execution route changed during selection', 'route_changed'],
  ['Selected execution proof superseded', 'selected_proof_superseded'],
  ['Peer execution access probe pending', 'peer_probe_pending'],
] as const);
type WaitReason =
  | (typeof DEFERRED_REASONS extends Map<string, infer Reason> ? Reason : never)
  | 'chat_state_missing'
  | 'no_eligible_executor'
  | 'other_deferred';
type CandidateWaitCounts = {
  candidateCount: number;
  activationRequiredCount: number;
  capabilityDeniedCount: number;
  proofMissingCount: number;
  snapshotChangedCount: number;
};
export type MaxExecutionOwnerReadinessInput = {
  chatId: string;
  preferredBotId?: string | null;
  force?: boolean;
  purpose?: MaxExecutionPurpose;
};

@Injectable()
export class MaxExecutionOwnerReadinessService implements OnModuleDestroy {
  private readonly logger = new Logger(MaxExecutionOwnerReadinessService.name);
  private readonly waitLogs = new Map<string, { at: number; count: number }>();
  private readonly inFlight = new Map<string, Promise<MaxExecutionRouteProof | null>>();
  private stopping = false;

  constructor(
    private readonly maxBotLink: MaxBotLinkService,
    private readonly maxClient: MaxClientService,
    private readonly locks: RedisCounterService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.inFlight.values()]);
    this.waitLogs.clear();
  }

  async ensureReady(
    params: MaxExecutionOwnerReadinessInput,
  ): Promise<MaxExecutionRouteProof | null> {
    const chatId = params.chatId.trim();
    if (!chatId || this.stopping)
      throw new WebhookPreparationDeferredError('Execution owner readiness stopped', 1_000);
    const purpose = params.purpose ?? 'moderation';
    const key = JSON.stringify([
      chatId,
      purpose,
      params.force === true,
      purpose === 'moderation' ? null : (params.preferredBotId ?? null),
    ]);
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const task = this.ensureReadyAdmitted({ ...params, chatId, purpose })
      .catch((error: unknown) => {
        if (error instanceof WebhookPreparationDeferredError) {
          this.recordWait(
            DEFERRED_REASONS.get(error.message as Parameters<typeof DEFERRED_REASONS.get>[0]) ??
              'other_deferred',
            purpose,
          );
          throw new WebhookExecutionOwnerUnavailableError(error.message, error.retryAfterMs, error);
        }
        throw error;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);
    return task;
  }

  private async ensureReadyAdmitted(
    params: MaxExecutionOwnerReadinessInput & { purpose: MaxExecutionPurpose },
  ): Promise<MaxExecutionRouteProof | null> {
    let state = await this.maxBotLink.loadChatExecutionOwnerState(params.chatId);
    if (!state) {
      this.recordWait('chat_state_missing', params.purpose);
      return null;
    }
    const originalOwner = state.primaryBotId;
    const requestedRoute =
      params.purpose === 'moderation'
        ? originalOwner
        : params.preferredBotId?.trim() || originalOwner;
    const current = requestedRoute
      ? executionRouteProof(state, requestedRoute, params.purpose)
      : null;
    if (current && !params.force) return current;
    const lockKey = `maxim:executor-readiness:${createHash('sha256').update(params.chatId).digest('hex')}`;
    const token = await this.locks.acquireLock(lockKey, PROBE_LEASE_MS);
    if (!token)
      throw new WebhookPreparationDeferredError('Execution owner probe already active', 1_000);
    try {
      state = await this.maxBotLink.loadChatExecutionOwnerState(params.chatId);
      if (!state) {
        this.recordWait('chat_state_missing', params.purpose);
        return null;
      }
      const owner = state.primaryBotId;
      const routeTarget =
        params.purpose === 'moderation' ? owner : params.preferredBotId?.trim() || owner;
      const ownerProof = routeTarget
        ? executionRouteProof(state, routeTarget, params.purpose)
        : null;
      if (ownerProof && !params.force) return ownerProof;
      const candidateIds = [
        ...new Set(
          [
            routeTarget,
            owner,
            ...state.candidates.map((candidate) => candidate.botId).sort(),
          ].filter((id): id is string =>
            Boolean(
              id &&
              (!state!.fixedModeratorBotId || id === state!.fixedModeratorBotId) &&
              state!.candidates.some((candidate) => candidate.botId === id),
            ),
          ),
        ),
      ];
      const waitCounts: CandidateWaitCounts = {
        candidateCount: candidateIds.length,
        activationRequiredCount: 0,
        capabilityDeniedCount: 0,
        proofMissingCount: 0,
        snapshotChangedCount: 0,
      };
      let previousOwner:
        | { botId: string; accessEpoch: MaxExecutionAccessEpoch; purpose: MaxExecutionPurpose }
        | undefined;
      let transientError: unknown;
      for (const botId of candidateIds) {
        if (!(await this.locks.renewLock(lockKey, token, PROBE_LEASE_MS)))
          throw new WebhookPreparationDeferredError('Execution owner probe lease lost', 1_000);
        state = await this.maxBotLink.loadChatExecutionOwnerState(params.chatId);
        if (!state) {
          this.recordWait('chat_state_missing', params.purpose);
          return null;
        }
        if (state.fixedModeratorBotId && state.fixedModeratorBotId !== botId) {
          waitCounts.snapshotChangedCount += 1;
          continue;
        }
        const membership = state.candidates.find((candidate) => candidate.botId === botId);
        if (!membership) {
          waitCounts.snapshotChangedCount += 1;
          continue;
        }
        if (isMajorManagedEntityActivationRequired(membership, state.entityType)) {
          waitCounts.activationRequiredCount += 1;
          // FLAG: A dormant owner is never re-probed, but its exact negative epoch still
          // fences peer promotion against a concurrent explicit administrator activation.
          if (botId === owner && membership.botAccessCheckedAt && membership.botAccessSource)
            previousOwner = {
              botId,
              accessEpoch: {
                checkedAt: membership.botAccessCheckedAt,
                source: membership.botAccessSource,
              },
              purpose: params.purpose,
            };
          continue;
        }
        const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
        // FLAG: A known missing optional capability waits for explicit activation. An
        // omitted channel read proof is unknown, so the exact channel GET remains allowed.
        if (
          !(params.purpose === 'moderation' && state.entityType === ChatEntityType.CHANNEL) &&
          ((snapshot?.activationCapabilityCeiling &&
            !snapshot.activationCapabilityCeiling.includes(params.purpose)) ||
            (snapshot?.permissionsKnown === true &&
              !hasExecutionCapability(membership, state.entityType, params.purpose)))
        ) {
          waitCounts.capabilityDeniedCount += 1;
          continue;
        }
        const proofMissing = !executionRouteProof(state, botId, params.purpose);
        const permissionsUnknown =
          normalizeMembershipAccessSnapshot(membership.permissionsSnapshot)?.permissionsKnown !==
          true;
        const negativeProofDue =
          proofMissing &&
          (membership.botAccessCheckedAt?.getTime() ?? 0) + NEGATIVE_PROBE_RECHECK_MS <= Date.now();
        const channelReadProofMissing =
          params.purpose === 'moderation' &&
          state.entityType === ChatEntityType.CHANNEL &&
          proofMissing &&
          hasExecutionCapability(membership, state.entityType, 'send_message');
        if (
          !hasFreshExecutionAccess(membership) ||
          permissionsUnknown ||
          negativeProofDue ||
          channelReadProofMissing ||
          (params.force && botId === routeTarget)
        ) {
          const checkedAt = new Date();
          try {
            const access = await this.maxClient.getCurrentChatMemberAccess(params.chatId, {
              botId,
              bypassCache: true,
              timeoutMs: 1_500,
              trafficClass: 'interactive',
              actionHealthLane: 'background',
              sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
              ignoreFailureMetricStatuses: [403, 404],
            });
            let channelReadVerified = false;
            if (
              state.entityType === ChatEntityType.CHANNEL &&
              (access?.isAdmin || access?.isOwner) &&
              access.permissionsKnown
            ) {
              const snapshot = await this.maxClient.getChatSnapshot(params.chatId, {
                botId,
                bypassCache: true,
                timeoutMs: 1_500,
                trafficClass: 'interactive',
                actionHealthLane: 'background',
                sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
                ignoreFailureMetricStatuses: [403, 404],
              });
              channelReadVerified =
                snapshot.chatId === params.chatId && snapshot.entityType === 'channel';
            }
            const accepted = await this.maxBotLink.recordBotAccessProbe({
              chatId: params.chatId,
              botId,
              access,
              source: PROBE_SOURCE,
              checkedAt,
              allowMembershipRecovery: false,
              channelReadVerified,
            });
            if (!accepted)
              throw new WebhookPreparationDeferredError('Execution access probe superseded', 1_000);
          } catch (error: unknown) {
            const status = this.errorStatus(error);
            if (status === 403 || status === 404) {
              const accepted = await this.maxBotLink.recordBotAccessProbe({
                chatId: params.chatId,
                botId,
                access: null,
                source: PROBE_SOURCE,
                checkedAt,
                allowMembershipRecovery: false,
              });
              if (!accepted)
                throw new WebhookPreparationDeferredError(
                  'Execution denial probe superseded',
                  1_000,
                );
            } else {
              // FLAG: A timeout/rate limit never supplies a negative epoch and cannot authorize
              // a primary switch. Keep a current unknown owner fenced until its probe settles.
              if (botId === owner && params.purpose === 'moderation')
                throw new WebhookPreparationDeferredError(
                  'Current execution owner probe pending',
                  1_000,
                  error,
                );
              transientError ??= error;
              continue;
            }
          }
          state = await this.maxBotLink.loadChatExecutionOwnerState(params.chatId);
          if (!state) {
            this.recordWait('chat_state_missing', params.purpose);
            return null;
          }
        }
        const latestMembership = state.candidates.find((candidate) => candidate.botId === botId);
        if (botId === owner && latestMembership && hasFreshExecutionAccess(latestMembership)) {
          const snapshot = normalizeMembershipAccessSnapshot(latestMembership.permissionsSnapshot);
          // FLAG: Omitted permission fields are unknown, even after a successful admin GET.
          // They cannot prove capability loss or authorize a different moderation owner.
          if (
            params.purpose === 'moderation' &&
            (snapshot?.isAdmin || snapshot?.isOwner) &&
            snapshot.permissionsKnown !== true
          ) {
            throw new WebhookPreparationDeferredError(
              'Current execution owner permissions unknown',
              1_000,
            );
          }
          if (
            snapshot &&
            (snapshot.permissionsKnown === true || (!snapshot.isAdmin && !snapshot.isOwner)) &&
            !hasExecutionCapability(latestMembership, state.entityType, params.purpose)
          ) {
            previousOwner = {
              botId,
              accessEpoch: {
                checkedAt: latestMembership.botAccessCheckedAt!,
                source: latestMembership.botAccessSource!,
              },
              purpose: params.purpose,
            };
          }
        }
        const proof = executionRouteProof(state, botId, params.purpose);
        if (!proof) {
          waitCounts.proofMissingCount += 1;
          continue;
        }
        // Mutation routes can use a capable peer without changing the shared read owner.
        if (params.purpose !== 'moderation') return proof;
        // A concurrent committed probe may already have promoted a healthy peer. Keep it stable.
        const stableProof = state.primaryBotId
          ? executionRouteProof(state, state.primaryBotId, params.purpose)
          : null;
        if (stableProof) return { ...stableProof, changed: stableProof.botId !== originalOwner };
        if (!(await this.locks.renewLock(lockKey, token, PROBE_LEASE_MS)))
          throw new WebhookPreparationDeferredError('Execution owner probe lease lost', 1_000);
        const selected = await this.maxBotLink.selectChatPrimaryBot({
          chatId: params.chatId,
          botId,
          expectedRoutingVersion: state.routingVersion,
          expectedAccessEpoch: proof.accessEpoch,
          expectedPreviousOwner: previousOwner,
        });
        if (!selected)
          throw new WebhookPreparationDeferredError(
            'Execution route changed during selection',
            1_000,
          );
        const acceptedProof = await this.maxBotLink.getFreshChatBotExecutionProof({
          chatId: params.chatId,
          botId,
          purpose: params.purpose,
        });
        if (!acceptedProof)
          throw new WebhookPreparationDeferredError('Selected execution proof superseded', 1_000);
        return { ...acceptedProof, changed: botId !== originalOwner };
      }
      if (transientError)
        throw new WebhookPreparationDeferredError(
          'Peer execution access probe pending',
          1_000,
          transientError,
        );
      this.recordWait('no_eligible_executor', params.purpose, waitCounts);
      return null;
    } finally {
      await this.locks.releaseLock(lockKey, token);
    }
  }

  private recordWait(
    reason: WaitReason,
    purpose: MaxExecutionPurpose,
    counts?: CandidateWaitCounts,
  ): void {
    // FLAG: Diagnostics never supply authority or alter retries. Keys are a finite reason/purpose
    // set; emit only enum labels and counters, never chat/bot identities, errors or permission data.
    const safePurpose = [
      'moderation',
      'delete_message',
      'edit_message',
      'moderate_member',
      'send_message',
    ].includes(purpose)
      ? purpose
      : 'unknown';
    const key = `${reason}:${safePurpose}`;
    const now = Date.now();
    const previous = this.waitLogs.get(key);
    if (previous && now >= previous.at && now - previous.at < WAIT_LOG_INTERVAL_MS) {
      previous.count += 1;
      return;
    }
    this.waitLogs.set(key, { at: now, count: 0 });
    try {
      this.logger.warn(
        {
          reason,
          purpose: safePurpose,
          coalescedObservations: (previous?.count ?? 0) + 1,
          ...(counts
            ? {
                candidateCount: counts.candidateCount,
                activationRequiredCount: counts.activationRequiredCount,
                capabilityDeniedCount: counts.capabilityDeniedCount,
                proofMissingCount: counts.proofMissingCount,
                snapshotChangedCount: counts.snapshotChangedCount,
              }
            : {}),
        },
        'Moderation executor readiness is waiting',
      );
    } catch {
      /* Diagnostic sinks cannot change execution behavior. */
    }
  }

  private errorStatus(error: unknown): number | null {
    const candidate = error as { status?: unknown; response?: { status?: unknown } } | null;
    const status = candidate?.response?.status ?? candidate?.status;
    return typeof status === 'number' ? status : null;
  }
}
