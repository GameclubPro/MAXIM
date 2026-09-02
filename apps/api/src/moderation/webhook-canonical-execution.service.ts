import { Injectable, Logger } from '@nestjs/common';
import type { MaxUpdate } from '@maxim/contracts';
import { randomUUID } from 'node:crypto';

import { Prisma, WebhookStatus, type WebhookEvent } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { buildWebhookSemanticEventKey } from '../webhook/webhook-semantic-event-key';
import {
  buildPendingWebhookTimeoutQuarantineMessage,
  buildTerminalWebhookTimeoutQuarantineMessage,
  isPendingWebhookTimeoutQuarantineMessage,
  isTerminalWebhookTimeoutQuarantineMessage,
  WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_HEARTBEAT_MS,
  WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_LEASE_MS,
  WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX,
} from '../webhook/webhook-timeout-quarantine';
import { WebhookOrderedPredecessorPendingError } from './webhook-ordered-predecessor-fence';

export { WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX } from '../webhook/webhook-timeout-quarantine';

const WEBHOOK_CANONICAL_BUSINESS_LEASE_MS = 5 * 60_000;

type WebhookExecutionClaimRecord = {
  id?: string;
  semanticKey?: string;
  webhookEventId?: string;
  executionBotId?: string | null;
  enforced?: boolean;
  status?: string;
  preparedAt?: Date | null;
  completedAt?: Date | null;
  leaseToken?: string | null;
  leaseExpiresAt?: Date | null;
};

type WebhookExecutionClaimModel = {
  findFirst?: (args: unknown) => Promise<WebhookExecutionClaimRecord | null>;
  findUnique?: (args: unknown) => Promise<WebhookExecutionClaimRecord | null>;
  updateMany?: (args: unknown) => Promise<{ count?: number }>;
};

export type WebhookCanonicalPersistenceClient = {
  webhookEvent: {
    findUnique?: (args: unknown) => Promise<{
      id: string;
      status: WebhookStatus;
      normalizedPayload: unknown;
      errorMessage: string | null;
      processedAt: Date | null;
      nextEnqueueAt: Date | null;
      timeoutQuarantineExpiresAt: Date | null;
    } | null>;
    updateMany: (args: unknown) => Promise<{ count: number }>;
  };
  webhookExecutionClaim?: WebhookExecutionClaimModel;
};

type OrderedWebhookPredecessor = {
  id: string;
};

export class WebhookTimeoutSettlementCasLostError extends Error {}

const WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER = `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`;
const WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER_LENGTH_SQL = Prisma.raw(
  String(WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER.length),
);
const WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER_SQL = Prisma.raw(
  `'${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER.replaceAll("'", "''")}'`,
);

const WEBHOOK_EXECUTION_CLAIM_SELECT = {
  id: true,
  semanticKey: true,
  webhookEventId: true,
  executionBotId: true,
  enforced: true,
  status: true,
  preparedAt: true,
  completedAt: true,
  leaseToken: true,
  leaseExpiresAt: true,
} as const;

export type WebhookCanonicalExecutionContext = {
  webhookEvent: WebhookEvent;
  update: MaxUpdate;
  activeBotId: string | null;
  businessLeaseToken: string | null;
};

export type WebhookTimeoutQuarantineLease = {
  errorMessage: string;
  deadlineAt: Date;
};

export type WebhookTimeoutQuarantineHeartbeat = {
  stop: () => Promise<WebhookTimeoutQuarantineLease>;
};

export type WebhookUnquarantinedSettlementResult = 'quarantined' | 'settled';

export type WebhookTimeoutSettlementResult =
  | WebhookUnquarantinedSettlementResult
  | 'duplicate'
  | 'retry';

export type WebhookShadowMirrorSettlementContext = {
  webhookEvent: Pick<WebhookEvent, 'id'>;
  update: unknown;
  businessLeaseToken: string | null;
};

export type WebhookShadowMirrorSettlementResult = 'settled' | 'retry' | 'invalid';

@Injectable()
export class WebhookCanonicalExecutionService {
  private readonly logger = new Logger(WebhookCanonicalExecutionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async prepareExecution(
    webhookEventId: string,
    defaultBotId: string | null | undefined,
  ): Promise<WebhookCanonicalExecutionContext | null> {
    const webhookEvent = await this.prisma.webhookEvent.findUnique({
      where: { id: webhookEventId },
    });

    if (!webhookEvent) {
      return null;
    }
    if (
      webhookEvent.status === WebhookStatus.DUPLICATE ||
      webhookEvent.status === WebhookStatus.PROCESSED
    ) {
      return null;
    }
    if (this.isHotPathTimeoutQuarantined(webhookEvent)) {
      this.logger.warn(
        { webhookEventId: webhookEvent.id },
        'Skipped webhook execution that is quarantined after a hot-path timeout',
      );
      return null;
    }

    const update = webhookEvent.normalizedPayload as MaxUpdate;
    const normalizedUpdateType = update.type.trim().toLowerCase();
    const executionClaimModel = this.executionClaimModel;
    const semanticKey = buildWebhookSemanticEventKey(update);
    const semanticClaim =
      semanticKey && typeof executionClaimModel?.findUnique === 'function'
        ? await executionClaimModel.findUnique({
            where: {
              kind_semanticKey: {
                kind: 'EXECUTION',
                semanticKey,
              },
            },
            select: WEBHOOK_EXECUTION_CLAIM_SELECT,
          })
        : null;
    const executionClaim =
      semanticClaim ??
      (typeof executionClaimModel?.findFirst === 'function'
        ? await executionClaimModel.findFirst({
            where: {
              webhookEventId: webhookEvent.id,
              kind: 'EXECUTION',
            },
            select: WEBHOOK_EXECUTION_CLAIM_SELECT,
          })
        : null);

    if (
      executionClaim?.enforced === true &&
      executionClaim.webhookEventId &&
      executionClaim.webhookEventId !== webhookEvent.id
    ) {
      this.logger.warn(
        { webhookEventId: webhookEvent.id },
        'Skipped active non-canonical mirrored webhook job at the worker fence',
      );
      return null;
    }
    if (
      executionClaim?.enforced !== true &&
      executionClaim?.webhookEventId &&
      executionClaim.webhookEventId !== webhookEvent.id &&
      executionClaim.preparedAt == null &&
      (normalizedUpdateType === 'user_added' || normalizedUpdateType === 'user_removed')
    ) {
      // FLAG: A rolling deployment can leave an older shadow mirror job active while the
      // canonical receipt is still preparing. The worker must not bypass the outbox fence.
      this.logger.warn(
        {
          webhookEventId: webhookEvent.id,
          canonicalWebhookEventId: executionClaim.webhookEventId,
        },
        'Deferred shadow webhook mirror until canonical preparation is ready',
      );
      return null;
    }
    if (
      executionClaim?.enforced === true &&
      executionClaim.webhookEventId === webhookEvent.id &&
      executionClaim.status !== 'READY' &&
      executionClaim.status !== 'COMPLETED'
    ) {
      throw new Error(`Canonical webhook claim is not ready for ${webhookEvent.id}`);
    }
    if (
      executionClaim?.webhookEventId === webhookEvent.id &&
      executionClaim.status === 'COMPLETED'
    ) {
      // FLAG: Completion is authoritative in both enforced and shadow modes; a retry may repair
      // the receipt, but it must never reacquire a business lease or repeat side effects.
      await this.prisma.webhookEvent.updateMany({
        where: {
          id: webhookEvent.id,
          status: { not: WebhookStatus.PROCESSED },
        },
        data: {
          status: WebhookStatus.PROCESSED,
          processedAt: executionClaim.completedAt ?? new Date(),
          queueName: null,
          errorMessage: null,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: null,
        },
      });
      return null;
    }

    await this.assertNoOutstandingOrderedPredecessor(webhookEvent, update);

    const businessLeaseToken = await this.acquireBusinessLease({
      webhookEventId: webhookEvent.id,
      executionClaim,
      executionClaimModel,
    });

    const context: WebhookCanonicalExecutionContext = {
      webhookEvent,
      update,
      activeBotId:
        this.normalizeBotId(executionClaim?.executionBotId) ??
        this.normalizeBotId(webhookEvent.botId) ??
        this.normalizeBotId(update.botId) ??
        this.normalizeBotId(defaultBotId),
      businessLeaseToken,
    };

    // Recheck after a fenced claim: another worker can have read this event before a timeout
    // quarantine was persisted, then win the claim after its original owner finishes.
    if (businessLeaseToken) {
      const latestWebhookEvent = await this.prisma.webhookEvent.findUnique({
        where: { id: webhookEvent.id },
      });
      if (
        !latestWebhookEvent ||
        latestWebhookEvent.status === WebhookStatus.DUPLICATE ||
        latestWebhookEvent.status === WebhookStatus.PROCESSED ||
        this.isHotPathTimeoutQuarantined(latestWebhookEvent)
      ) {
        await this.releaseBusinessLease(context);
        if (latestWebhookEvent && this.isHotPathTimeoutQuarantined(latestWebhookEvent)) {
          this.logger.warn(
            { webhookEventId: latestWebhookEvent.id },
            'Released a stale canonical claim after a hot-path timeout quarantine',
          );
        }
        return null;
      }
    }

    return context;
  }

  async completeExecution(context: WebhookCanonicalExecutionContext): Promise<void> {
    const executionClaimModel = this.executionClaimModel;
    if (typeof executionClaimModel?.updateMany === 'function') {
      const completion = await executionClaimModel.updateMany({
        where: {
          webhookEventId: context.webhookEvent.id,
          kind: 'EXECUTION',
          ...(context.businessLeaseToken ? { leaseToken: context.businessLeaseToken } : {}),
        },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      if (context.businessLeaseToken && completion?.count !== 1) {
        throw new Error(
          `Canonical webhook business lease was lost before completion for ${context.webhookEvent.id}`,
        );
      }
    }

    await this.prisma.webhookEvent.update({
      where: { id: context.webhookEvent.id },
      data: {
        status: WebhookStatus.PROCESSED,
        processedAt: new Date(),
        errorMessage: null,
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
      },
    });
  }

  async failExecution(
    context: WebhookCanonicalExecutionContext,
    params: { errorMessage: string; terminal: boolean; retryAfterMs?: number },
  ): Promise<void> {
    await this.releaseBusinessLease(context);

    const requestedRetryAfterMs = Math.trunc(params.retryAfterMs ?? 0);
    const retryAfterMs =
      Number.isFinite(requestedRetryAfterMs) && requestedRetryAfterMs > 0
        ? requestedRetryAfterMs
        : 15_000;

    const recoveredRawPayload =
      context.update.raw &&
      typeof context.update.raw === 'object' &&
      !Array.isArray(context.update.raw)
        ? (context.update.raw as Record<string, unknown>)
        : null;
    await this.prisma.webhookEvent.update({
      where: { id: context.webhookEvent.id },
      data: {
        status: WebhookStatus.FAILED,
        errorMessage: params.errorMessage,
        nextEnqueueAt: params.terminal ? null : new Date(Date.now() + retryAfterMs),
        timeoutQuarantineExpiresAt: null,
        ...(recoveredRawPayload
          ? { rawPayload: recoveredRawPayload as Prisma.InputJsonValue }
          : {}),
      },
    });
  }

  // FLAG: An unfenced timeout settlement must persist before its exact business lease is released.
  // Shadow claims are promoted to enforced; without any semantic claim, retain an ordered-head
  // quarantine instead of allowing a mirrored receipt to replay ambiguous side effects.
  async settleUnquarantinedTimedOutExecution(
    context: WebhookCanonicalExecutionContext,
    outcome: { kind: 'completed'; timeoutErrorMessage: string } | { kind: 'failed'; error: string },
  ): Promise<WebhookUnquarantinedSettlementResult> {
    const settledAt = new Date();
    const noClaimQuarantineErrorMessage = buildPendingWebhookTimeoutQuarantineMessage(
      randomUUID(),
      outcome.kind === 'failed'
        ? `detached execution failed without a canonical claim: ${outcome.error}`
        : `detached execution completed without a canonical claim: ${outcome.timeoutErrorMessage}`,
    );
    const recoveredRawPayload =
      context.update.raw &&
      typeof context.update.raw === 'object' &&
      !Array.isArray(context.update.raw)
        ? (context.update.raw as Record<string, unknown>)
        : null;

    return this.runInTransaction(async (client) => {
      const executionClaimModel = client.webhookExecutionClaim;
      let hasSemanticClaim = Boolean(context.businessLeaseToken);

      if (!context.businessLeaseToken && typeof executionClaimModel?.updateMany === 'function') {
        const claimFence = await executionClaimModel.updateMany({
          where: {
            webhookEventId: context.webhookEvent.id,
            kind: 'EXECUTION',
            enforced: false,
            status: 'READY',
            leaseToken: null,
            leaseExpiresAt: null,
          },
          data:
            outcome.kind === 'completed'
              ? {
                  enforced: true,
                  status: 'COMPLETED',
                  completedAt: settledAt,
                  leaseToken: null,
                  leaseExpiresAt: null,
                }
              : {
                  enforced: true,
                  leaseToken: null,
                  leaseExpiresAt: null,
                },
        });
        hasSemanticClaim = claimFence.count === 1;
      }

      const eventUpdate = await client.webhookEvent.updateMany({
        where: {
          id: context.webhookEvent.id,
          status: {
            in:
              outcome.kind === 'completed'
                ? [
                    WebhookStatus.RECEIVED,
                    WebhookStatus.QUEUED,
                    WebhookStatus.FAILED,
                    WebhookStatus.PROCESSED,
                  ]
                : [WebhookStatus.RECEIVED, WebhookStatus.QUEUED, WebhookStatus.FAILED],
          },
        },
        data: hasSemanticClaim
          ? outcome.kind === 'completed'
            ? {
                status: WebhookStatus.PROCESSED,
                processedAt: settledAt,
                errorMessage: null,
                nextEnqueueAt: null,
                timeoutQuarantineExpiresAt: null,
              }
            : {
                status: WebhookStatus.FAILED,
                errorMessage: buildTerminalWebhookTimeoutQuarantineMessage(outcome.error),
                nextEnqueueAt: null,
                timeoutQuarantineExpiresAt: null,
                ...(recoveredRawPayload
                  ? { rawPayload: recoveredRawPayload as Prisma.InputJsonValue }
                  : {}),
              }
          : {
              status: WebhookStatus.FAILED,
              errorMessage: noClaimQuarantineErrorMessage,
              nextEnqueueAt: null,
              // This is a durable replay fence, not a live detached execution heartbeat.
              timeoutQuarantineExpiresAt: null,
            },
      });
      if (eventUpdate.count !== 1) {
        throw new Error(
          `Webhook state changed before unfenced timeout settlement for ${context.webhookEvent.id}`,
        );
      }

      if (context.businessLeaseToken) {
        if (typeof executionClaimModel?.updateMany !== 'function') {
          throw new Error(
            `Canonical webhook business lease storage is unavailable for ${context.webhookEvent.id}`,
          );
        }
        const claimSettlement = await executionClaimModel.updateMany({
          where: {
            webhookEventId: context.webhookEvent.id,
            kind: 'EXECUTION',
            OR:
              outcome.kind === 'completed'
                ? [
                    { status: 'READY', leaseToken: context.businessLeaseToken },
                    { status: 'COMPLETED', leaseToken: null },
                  ]
                : [
                    { status: 'READY', leaseToken: context.businessLeaseToken },
                    { status: 'READY', leaseToken: null, enforced: true },
                  ],
          },
          data:
            outcome.kind === 'completed'
              ? {
                  enforced: true,
                  status: 'COMPLETED',
                  completedAt: settledAt,
                  leaseToken: null,
                  leaseExpiresAt: null,
                }
              : {
                  enforced: true,
                  leaseToken: null,
                  leaseExpiresAt: null,
                },
        });
        if (claimSettlement.count !== 1) {
          throw new Error(
            `Canonical webhook business lease was lost before unfenced timeout settlement for ${context.webhookEvent.id}`,
          );
        }
      }

      return hasSemanticClaim ? 'settled' : 'quarantined';
    });
  }

  // FLAG: A watchdog timeout can leave a MAX action in flight. The exact marker and deadline fence
  // heartbeat, completion, and failure CAS operations. Deadline expiry is diagnostic only and must
  // never let another actor release or replay the ordered chat head.
  async quarantineTimedOutExecution(
    context: WebhookCanonicalExecutionContext,
    params: { errorMessage: string },
  ): Promise<WebhookTimeoutQuarantineLease> {
    const lease: WebhookTimeoutQuarantineLease = {
      errorMessage: buildPendingWebhookTimeoutQuarantineMessage(randomUUID(), params.errorMessage),
      deadlineAt: new Date(Date.now() + WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_LEASE_MS),
    };
    const persisted = await this.runInTransaction(async (client) => {
      const eventUpdate = await client.webhookEvent.updateMany({
        where: {
          id: context.webhookEvent.id,
          status: {
            in: [WebhookStatus.RECEIVED, WebhookStatus.QUEUED, WebhookStatus.FAILED],
          },
        },
        data: {
          status: WebhookStatus.FAILED,
          errorMessage: lease.errorMessage,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: lease.deadlineAt,
        },
      });
      if (eventUpdate.count !== 1) {
        return false;
      }
      await this.extendBusinessLeaseWithClient(client, context, lease.deadlineAt);
      return true;
    });
    if (!persisted) {
      throw new Error(
        `Webhook timeout quarantine state changed before persistence for ${context.webhookEvent.id}`,
      );
    }
    return lease;
  }

  startTimedOutExecutionHeartbeat(
    context: WebhookCanonicalExecutionContext,
    initialLease: WebhookTimeoutQuarantineLease,
  ): WebhookTimeoutQuarantineHeartbeat {
    let currentLease = initialLease;
    let stopped = false;
    let inFlight: Promise<void> | null = null;
    const timer = setInterval(() => {
      if (stopped || inFlight) {
        return;
      }
      const leaseSnapshot = currentLease;
      inFlight = this.refreshTimedOutExecutionQuarantine(context, leaseSnapshot)
        .then((refreshedLease) => {
          if (refreshedLease) {
            currentLease = refreshedLease;
            return;
          }
          stopped = true;
          clearInterval(timer);
          this.logger.error(
            { webhookEventId: context.webhookEvent.id },
            'Lost the pending webhook timeout quarantine heartbeat fence',
          );
        })
        .catch((error: unknown) => {
          this.logger.error(
            {
              webhookEventId: context.webhookEvent.id,
              err: error instanceof Error ? error.message : String(error),
            },
            'Could not refresh a pending webhook timeout quarantine',
          );
        })
        .finally(() => {
          inFlight = null;
        });
    }, WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_HEARTBEAT_MS);
    timer.unref?.();

    return {
      stop: async () => {
        stopped = true;
        clearInterval(timer);
        // The independent hard watchdog remains authoritative if an in-flight Prisma refresh hangs.
        return currentLease;
      },
    };
  }

  async refreshTimedOutExecutionQuarantine(
    context: WebhookCanonicalExecutionContext,
    lease: WebhookTimeoutQuarantineLease,
  ): Promise<WebhookTimeoutQuarantineLease | null> {
    const refreshedLease: WebhookTimeoutQuarantineLease = {
      errorMessage: lease.errorMessage,
      deadlineAt: new Date(Date.now() + WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_LEASE_MS),
    };
    const refreshed = await this.runInTransaction(async (client) => {
      const eventUpdate = await client.webhookEvent.updateMany({
        where: this.buildTimeoutQuarantineLeaseWhere(context, lease),
        data: {
          timeoutQuarantineExpiresAt: refreshedLease.deadlineAt,
        },
      });
      if (eventUpdate.count !== 1) {
        return false;
      }
      await this.extendBusinessLeaseWithClient(client, context, refreshedLease.deadlineAt);
      return true;
    });
    return refreshed ? refreshedLease : null;
  }

  async completeTimedOutExecution(
    context: WebhookCanonicalExecutionContext,
    lease: WebhookTimeoutQuarantineLease,
  ): Promise<WebhookTimeoutSettlementResult> {
    const completedAt = new Date();
    try {
      return await this.runInTransaction(async (client) => {
        const freshEventSettlement = await client.webhookEvent.updateMany({
          where: this.buildTimeoutQuarantineLeaseWhere(context, lease),
          data: {
            status: WebhookStatus.PROCESSED,
            processedAt: completedAt,
            errorMessage: null,
            nextEnqueueAt: null,
            timeoutQuarantineExpiresAt: null,
          },
        });
        const isFreshSettlement = freshEventSettlement.count === 1;
        if (!isFreshSettlement) {
          const idempotentDuplicateSettlement = await client.webhookEvent.updateMany({
            where: {
              id: context.webhookEvent.id,
              status: WebhookStatus.DUPLICATE,
              processedAt: { not: null },
              errorMessage: null,
              queueName: null,
              nextEnqueueAt: null,
              timeoutQuarantineExpiresAt: null,
            },
            data: {
              status: WebhookStatus.DUPLICATE,
              errorMessage: null,
              queueName: null,
              nextEnqueueAt: null,
              timeoutQuarantineExpiresAt: null,
            },
          });
          if (idempotentDuplicateSettlement.count === 1) {
            return 'duplicate';
          }

          const retainedFenceWhere: Prisma.WebhookEventWhereInput = {
            id: context.webhookEvent.id,
            status: WebhookStatus.FAILED,
            processedAt: null,
            errorMessage: lease.errorMessage,
            nextEnqueueAt: null,
            timeoutQuarantineExpiresAt: null,
          };
          const retainedFence = await client.webhookEvent.updateMany({
            where: retainedFenceWhere,
            data: {
              status: WebhookStatus.FAILED,
              processedAt: null,
              errorMessage: lease.errorMessage,
              nextEnqueueAt: null,
              timeoutQuarantineExpiresAt: null,
            },
          });
          if (retainedFence.count === 1) {
            const mirrorSettlement =
              await WebhookCanonicalExecutionService.trySettleCompletedShadowMirrorWithClient(
                client,
                context,
                retainedFenceWhere,
              );
            if (mirrorSettlement === 'settled') {
              return 'duplicate';
            }
            if (mirrorSettlement === 'retry') {
              throw new WebhookTimeoutSettlementCasLostError(
                `Semantic webhook owner is still settling for ${context.webhookEvent.id}`,
              );
            }
            return 'quarantined';
          }

          const idempotentEventSettlement = await client.webhookEvent.updateMany({
            where: {
              id: context.webhookEvent.id,
              status: WebhookStatus.PROCESSED,
              processedAt: { not: null },
              errorMessage: null,
              nextEnqueueAt: null,
              timeoutQuarantineExpiresAt: null,
            },
            data: {
              status: WebhookStatus.PROCESSED,
              errorMessage: null,
              nextEnqueueAt: null,
              timeoutQuarantineExpiresAt: null,
            },
          });
          if (idempotentEventSettlement.count !== 1) {
            return 'retry';
          }
        }

        const executionClaimModel = client.webhookExecutionClaim;
        if (typeof executionClaimModel?.updateMany !== 'function') {
          throw new Error(
            `Canonical webhook business lease storage is unavailable for ${context.webhookEvent.id}`,
          );
        }
        const completion = await executionClaimModel.updateMany({
          where: {
            webhookEventId: context.webhookEvent.id,
            kind: 'EXECUTION',
            ...(isFreshSettlement
              ? context.businessLeaseToken
                ? {
                    enforced: true,
                    status: 'READY',
                    leaseToken: context.businessLeaseToken,
                  }
                : {
                    enforced: false,
                    status: 'READY',
                    leaseToken: null,
                    leaseExpiresAt: null,
                  }
              : {
                  enforced: true,
                  status: 'COMPLETED',
                  completedAt: { not: null },
                  leaseToken: null,
                  leaseExpiresAt: null,
                }),
          },
          data: {
            enforced: true,
            status: 'COMPLETED',
            ...(isFreshSettlement ? { completedAt } : {}),
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        if (completion.count !== 1) {
          if (isFreshSettlement) {
            const freshSettlementWhere: Prisma.WebhookEventWhereInput = {
              id: context.webhookEvent.id,
              status: WebhookStatus.PROCESSED,
              processedAt: completedAt,
              errorMessage: null,
              nextEnqueueAt: null,
              timeoutQuarantineExpiresAt: null,
            };
            const mirrorSettlement =
              await WebhookCanonicalExecutionService.trySettleCompletedShadowMirrorWithClient(
                client,
                context,
                freshSettlementWhere,
              );
            if (mirrorSettlement === 'settled') {
              return 'duplicate';
            }
            if (mirrorSettlement === 'retry') {
              throw new WebhookTimeoutSettlementCasLostError(
                `Semantic webhook owner is still settling for ${context.webhookEvent.id}`,
              );
            }

            const retainedFence = await client.webhookEvent.updateMany({
              where: freshSettlementWhere,
              data: {
                status: WebhookStatus.FAILED,
                processedAt: null,
                errorMessage: lease.errorMessage,
                nextEnqueueAt: null,
                timeoutQuarantineExpiresAt: null,
              },
            });
            if (retainedFence.count === 1) {
              return 'quarantined';
            }
          }
          throw new WebhookTimeoutSettlementCasLostError(
            `Canonical webhook claim was lost before timeout completion for ${context.webhookEvent.id}`,
          );
        }
        return 'settled';
      });
    } catch (error: unknown) {
      if (error instanceof WebhookTimeoutSettlementCasLostError) {
        return 'retry';
      }
      throw error;
    }
  }

  async failTimedOutExecution(
    context: WebhookCanonicalExecutionContext,
    lease: WebhookTimeoutQuarantineLease,
    params: { errorMessage: string },
  ): Promise<WebhookTimeoutSettlementResult> {
    const terminalErrorMessage = buildTerminalWebhookTimeoutQuarantineMessage(params.errorMessage);
    try {
      return await this.runInTransaction(async (client) => {
        const freshEventSettlement = await client.webhookEvent.updateMany({
          where: this.buildTimeoutQuarantineLeaseWhere(context, lease),
          data: {
            status: WebhookStatus.FAILED,
            errorMessage: terminalErrorMessage,
            nextEnqueueAt: null,
            timeoutQuarantineExpiresAt: null,
          },
        });
        const isFreshSettlement = freshEventSettlement.count === 1;
        if (!isFreshSettlement) {
          const idempotentDuplicateSettlement = await client.webhookEvent.updateMany({
            where: {
              id: context.webhookEvent.id,
              status: WebhookStatus.DUPLICATE,
              processedAt: { not: null },
              errorMessage: null,
              queueName: null,
              nextEnqueueAt: null,
              timeoutQuarantineExpiresAt: null,
            },
            data: {
              status: WebhookStatus.DUPLICATE,
              errorMessage: null,
              queueName: null,
              nextEnqueueAt: null,
              timeoutQuarantineExpiresAt: null,
            },
          });
          if (idempotentDuplicateSettlement.count === 1) {
            return 'duplicate';
          }

          const retainedFenceWhere: Prisma.WebhookEventWhereInput = {
            id: context.webhookEvent.id,
            status: WebhookStatus.FAILED,
            processedAt: null,
            errorMessage: lease.errorMessage,
            nextEnqueueAt: null,
            timeoutQuarantineExpiresAt: null,
          };
          const retainedFence = await client.webhookEvent.updateMany({
            where: retainedFenceWhere,
            data: {
              status: WebhookStatus.FAILED,
              processedAt: null,
              errorMessage: lease.errorMessage,
              nextEnqueueAt: null,
              timeoutQuarantineExpiresAt: null,
            },
          });
          if (retainedFence.count === 1) {
            const mirrorSettlement =
              await WebhookCanonicalExecutionService.trySettleCompletedShadowMirrorWithClient(
                client,
                context,
                retainedFenceWhere,
              );
            if (mirrorSettlement === 'settled') {
              return 'duplicate';
            }
            if (mirrorSettlement === 'retry') {
              throw new WebhookTimeoutSettlementCasLostError(
                `Semantic webhook owner is still settling for ${context.webhookEvent.id}`,
              );
            }
            return 'quarantined';
          }

          const idempotentEventSettlement = await client.webhookEvent.updateMany({
            where: {
              id: context.webhookEvent.id,
              status: WebhookStatus.FAILED,
              errorMessage: terminalErrorMessage,
              nextEnqueueAt: null,
              timeoutQuarantineExpiresAt: null,
            },
            data: {
              status: WebhookStatus.FAILED,
              errorMessage: terminalErrorMessage,
              nextEnqueueAt: null,
              timeoutQuarantineExpiresAt: null,
            },
          });
          if (idempotentEventSettlement.count !== 1) {
            return 'retry';
          }
        }

        const executionClaimModel = client.webhookExecutionClaim;
        if (typeof executionClaimModel?.updateMany !== 'function') {
          throw new Error(
            `Canonical webhook business lease storage is unavailable for ${context.webhookEvent.id}`,
          );
        }
        const failure = await executionClaimModel.updateMany({
          where: {
            webhookEventId: context.webhookEvent.id,
            kind: 'EXECUTION',
            ...(isFreshSettlement
              ? context.businessLeaseToken
                ? {
                    enforced: true,
                    status: 'READY',
                    leaseToken: context.businessLeaseToken,
                  }
                : {
                    enforced: false,
                    status: 'READY',
                    leaseToken: null,
                    leaseExpiresAt: null,
                  }
              : {
                  enforced: true,
                  status: 'READY',
                  completedAt: null,
                  leaseToken: null,
                  leaseExpiresAt: null,
                }),
          },
          data: {
            enforced: true,
            status: 'READY',
            completedAt: null,
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        if (failure.count !== 1) {
          if (isFreshSettlement) {
            const freshSettlementWhere: Prisma.WebhookEventWhereInput = {
              id: context.webhookEvent.id,
              status: WebhookStatus.FAILED,
              processedAt: null,
              errorMessage: terminalErrorMessage,
              nextEnqueueAt: null,
              timeoutQuarantineExpiresAt: null,
            };
            const mirrorSettlement =
              await WebhookCanonicalExecutionService.trySettleCompletedShadowMirrorWithClient(
                client,
                context,
                freshSettlementWhere,
              );
            if (mirrorSettlement === 'settled') {
              return 'duplicate';
            }
            if (mirrorSettlement === 'retry') {
              throw new WebhookTimeoutSettlementCasLostError(
                `Semantic webhook owner is still settling for ${context.webhookEvent.id}`,
              );
            }

            const retainedFence = await client.webhookEvent.updateMany({
              where: freshSettlementWhere,
              data: {
                status: WebhookStatus.FAILED,
                processedAt: null,
                errorMessage: lease.errorMessage,
                nextEnqueueAt: null,
                timeoutQuarantineExpiresAt: null,
              },
            });
            if (retainedFence.count === 1) {
              return 'quarantined';
            }
          }
          throw new WebhookTimeoutSettlementCasLostError(
            `Canonical webhook claim was lost before timeout failure for ${context.webhookEvent.id}`,
          );
        }
        return 'settled';
      });
    } catch (error: unknown) {
      if (error instanceof WebhookTimeoutSettlementCasLostError) {
        return 'retry';
      }
      throw error;
    }
  }

  // FLAG: A shadow mirror can converge only on a fully prepared, completed semantic owner whose
  // persisted payload still derives the same key. Transitional evidence retries under the live hard
  // fence; absent or inconsistent evidence retains a permanent replay fence.
  static async trySettleCompletedShadowMirrorWithClient(
    client: WebhookCanonicalPersistenceClient,
    context: WebhookShadowMirrorSettlementContext,
    mirrorWhere: Prisma.WebhookEventWhereInput,
  ): Promise<WebhookShadowMirrorSettlementResult> {
    if (context.businessLeaseToken !== null) {
      return 'invalid';
    }

    const semanticKey = buildWebhookSemanticEventKey(context.update);
    const executionClaimModel = client.webhookExecutionClaim;
    if (
      semanticKey === null ||
      typeof executionClaimModel?.findUnique !== 'function' ||
      typeof executionClaimModel.updateMany !== 'function' ||
      typeof client.webhookEvent.findUnique !== 'function'
    ) {
      return 'invalid';
    }

    const mirrorEvent = await client.webhookEvent.findUnique({
      where: { id: context.webhookEvent.id },
      select: {
        id: true,
        status: true,
        normalizedPayload: true,
        errorMessage: true,
        processedAt: true,
        nextEnqueueAt: true,
        timeoutQuarantineExpiresAt: true,
      },
    });
    if (
      !mirrorEvent ||
      mirrorEvent.id !== context.webhookEvent.id ||
      buildWebhookSemanticEventKey(mirrorEvent.normalizedPayload) !== semanticKey
    ) {
      return 'invalid';
    }

    const semanticClaim = await executionClaimModel.findUnique({
      where: {
        kind_semanticKey: {
          kind: 'EXECUTION',
          semanticKey,
        },
      },
      select: WEBHOOK_EXECUTION_CLAIM_SELECT,
    });
    if (
      !semanticClaim?.id ||
      semanticClaim.semanticKey !== semanticKey ||
      !semanticClaim.webhookEventId ||
      semanticClaim.webhookEventId === context.webhookEvent.id ||
      typeof semanticClaim.enforced !== 'boolean'
    ) {
      return 'invalid';
    }
    if (semanticClaim.status === 'PENDING' || semanticClaim.status === 'READY') {
      return 'retry';
    }
    if (
      semanticClaim.status !== 'COMPLETED' ||
      !(semanticClaim.preparedAt instanceof Date) ||
      !Number.isFinite(semanticClaim.preparedAt.getTime()) ||
      !(semanticClaim.completedAt instanceof Date) ||
      !Number.isFinite(semanticClaim.completedAt.getTime()) ||
      semanticClaim.leaseToken !== null ||
      semanticClaim.leaseExpiresAt !== null
    ) {
      return 'invalid';
    }

    const ownerEvent = await client.webhookEvent.findUnique({
      where: { id: semanticClaim.webhookEventId },
      select: {
        id: true,
        status: true,
        normalizedPayload: true,
        errorMessage: true,
        processedAt: true,
        nextEnqueueAt: true,
        timeoutQuarantineExpiresAt: true,
      },
    });
    if (!ownerEvent || buildWebhookSemanticEventKey(ownerEvent.normalizedPayload) !== semanticKey) {
      return 'invalid';
    }
    if (ownerEvent.status !== WebhookStatus.PROCESSED) {
      return ownerEvent.status === WebhookStatus.DUPLICATE ? 'invalid' : 'retry';
    }
    if (
      !(ownerEvent.processedAt instanceof Date) ||
      !Number.isFinite(ownerEvent.processedAt.getTime()) ||
      ownerEvent.errorMessage !== null ||
      ownerEvent.nextEnqueueAt !== null ||
      ownerEvent.timeoutQuarantineExpiresAt !== null
    ) {
      return 'invalid';
    }

    const ownerFence = await client.webhookEvent.updateMany({
      where: {
        id: ownerEvent.id,
        status: WebhookStatus.PROCESSED,
        normalizedPayload: {
          equals: ownerEvent.normalizedPayload as Prisma.InputJsonValue,
        },
        processedAt: ownerEvent.processedAt,
        errorMessage: null,
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
      },
      data: {
        status: WebhookStatus.PROCESSED,
        processedAt: ownerEvent.processedAt,
        errorMessage: null,
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
      },
    });
    if (ownerFence.count !== 1) {
      return 'retry';
    }

    const promotedClaim = await executionClaimModel.updateMany({
      where: {
        id: semanticClaim.id,
        kind: 'EXECUTION',
        semanticKey,
        webhookEventId: ownerEvent.id,
        enforced: semanticClaim.enforced,
        status: 'COMPLETED',
        preparedAt: semanticClaim.preparedAt,
        completedAt: semanticClaim.completedAt,
        leaseToken: null,
        leaseExpiresAt: null,
      },
      data: {
        enforced: true,
        status: 'COMPLETED',
        completedAt: semanticClaim.completedAt,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    if (promotedClaim.count !== 1) {
      return 'retry';
    }

    const duplicateSettlement = await client.webhookEvent.updateMany({
      where: {
        ...mirrorWhere,
        normalizedPayload: {
          equals: mirrorEvent.normalizedPayload as Prisma.InputJsonValue,
        },
      },
      data: {
        status: WebhookStatus.DUPLICATE,
        processedAt: semanticClaim.completedAt,
        errorMessage: null,
        queueName: null,
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
      },
    });
    if (duplicateSettlement.count !== 1) {
      throw new WebhookTimeoutSettlementCasLostError(
        `Shadow mirror changed before timeout convergence for ${context.webhookEvent.id}`,
      );
    }
    return 'settled';
  }

  private get executionClaimModel(): WebhookExecutionClaimModel | undefined {
    return (
      this.prisma as PrismaService & {
        webhookExecutionClaim?: WebhookExecutionClaimModel;
      }
    ).webhookExecutionClaim;
  }

  private async acquireBusinessLease(params: {
    webhookEventId: string;
    executionClaim: WebhookExecutionClaimRecord | null;
    executionClaimModel: WebhookExecutionClaimModel | undefined;
  }): Promise<string | null> {
    const { webhookEventId, executionClaim, executionClaimModel } = params;
    if (
      executionClaim?.enforced !== true ||
      !executionClaim.id ||
      executionClaim.webhookEventId !== webhookEventId ||
      typeof executionClaimModel?.updateMany !== 'function'
    ) {
      return null;
    }

    const now = new Date();
    const businessLeaseToken = randomUUID();
    const leaseResult = await executionClaimModel.updateMany({
      where: {
        id: executionClaim.id,
        status: 'READY',
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      },
      data: {
        leaseToken: businessLeaseToken,
        leaseExpiresAt: new Date(now.getTime() + WEBHOOK_CANONICAL_BUSINESS_LEASE_MS),
      },
    });
    if (leaseResult?.count === 0) {
      throw new Error(`Canonical webhook business lease is busy for ${webhookEventId}`);
    }
    return businessLeaseToken;
  }

  private async releaseBusinessLease(context: WebhookCanonicalExecutionContext): Promise<void> {
    const executionClaimModel = this.executionClaimModel;
    if (!context.businessLeaseToken || typeof executionClaimModel?.updateMany !== 'function') {
      return;
    }

    await executionClaimModel
      .updateMany({
        where: {
          webhookEventId: context.webhookEvent.id,
          kind: 'EXECUTION',
          leaseToken: context.businessLeaseToken,
          status: 'READY',
        },
        data: {
          leaseToken: null,
          leaseExpiresAt: null,
        },
      })
      .catch(() => undefined);
  }

  private async extendBusinessLeaseWithClient(
    client: WebhookCanonicalPersistenceClient,
    context: WebhookCanonicalExecutionContext,
    deadlineAt: Date,
  ): Promise<void> {
    if (!context.businessLeaseToken) {
      return;
    }
    const executionClaimModel = client.webhookExecutionClaim;
    if (typeof executionClaimModel?.updateMany !== 'function') {
      throw new Error(
        `Canonical webhook business lease storage is unavailable for ${context.webhookEvent.id}`,
      );
    }
    const extension = await executionClaimModel.updateMany({
      where: {
        webhookEventId: context.webhookEvent.id,
        kind: 'EXECUTION',
        status: 'READY',
        leaseToken: context.businessLeaseToken,
      },
      data: {
        leaseExpiresAt: deadlineAt,
      },
    });
    if (extension?.count !== 1) {
      throw new Error(
        `Canonical webhook business lease was lost during timeout quarantine for ${context.webhookEvent.id}`,
      );
    }
  }

  // FLAG: Jobs can already be present in BullMQ before the current outbox sees a timeout fence.
  // Recheck the committed per-chat head in every current worker before any business side effect.
  private async assertNoOutstandingOrderedPredecessor(
    webhookEvent: WebhookEvent,
    update: MaxUpdate,
  ): Promise<void> {
    const updateType = this.normalizeLowerString(update.type);
    const chatId = this.normalizeBotId(update.message?.chatId);
    if ((updateType !== 'message_created' && updateType !== 'message_edited') || chatId === null) {
      return;
    }

    const queryRaw = (
      this.prisma as PrismaService & {
        $queryRaw?: (query: Prisma.Sql) => Promise<OrderedWebhookPredecessor[]>;
      }
    ).$queryRaw;
    if (typeof queryRaw !== 'function') {
      return;
    }

    const predecessors = await queryRaw.call(
      this.prisma,
      Prisma.sql`
      SELECT "id"
      FROM "webhook_events"
      WHERE (
          "status" = ANY(ARRAY['RECEIVED', 'QUEUED']::"WebhookStatus"[])
          OR (
            "status" = 'FAILED'::"WebhookStatus"
            AND (
              "next_enqueue_at" IS NOT NULL
              OR LEFT(
                COALESCE("error_message", ''),
                ${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER_LENGTH_SQL}
              ) = ${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER_SQL}
            )
          )
        )
        AND LOWER(
          COALESCE(
            NULLIF(BTRIM("normalized_payload"->>'type'), ''),
            NULLIF(BTRIM("normalized_payload"->>'update_type'), '')
          )
        ) = ANY(ARRAY['message_created', 'message_edited'])
        AND COALESCE(
          NULLIF(BTRIM("normalized_payload"->'message'->>'chatId'), ''),
          NULLIF(BTRIM("normalized_payload"->>'chatId'), '')
        ) = ${chatId}
        AND (
          "created_at" < ${webhookEvent.createdAt}
          OR ("created_at" = ${webhookEvent.createdAt} AND "id" < ${webhookEvent.id})
        )
      ORDER BY "created_at" ASC, "id" ASC
      LIMIT 1
    `,
    );
    const predecessor = predecessors[0];
    if (predecessor) {
      throw new WebhookOrderedPredecessorPendingError(webhookEvent.id, predecessor.id);
    }
  }

  private buildTimeoutQuarantineLeaseWhere(
    context: WebhookCanonicalExecutionContext,
    lease: WebhookTimeoutQuarantineLease,
  ): Prisma.WebhookEventWhereInput {
    return {
      id: context.webhookEvent.id,
      status: WebhookStatus.FAILED,
      errorMessage: lease.errorMessage,
      nextEnqueueAt: null,
      timeoutQuarantineExpiresAt: lease.deadlineAt,
    };
  }

  private async runInTransaction<T>(
    operation: (client: WebhookCanonicalPersistenceClient) => Promise<T>,
  ): Promise<T> {
    const transaction = (
      this.prisma as PrismaService & {
        $transaction?: <R>(
          callback: (client: WebhookCanonicalPersistenceClient) => Promise<R>,
        ) => Promise<R>;
      }
    ).$transaction;
    if (typeof transaction !== 'function') {
      return operation(this.prisma as unknown as WebhookCanonicalPersistenceClient);
    }
    return transaction.call(this.prisma, operation) as Promise<T>;
  }

  private isHotPathTimeoutQuarantined(webhookEvent: WebhookEvent): boolean {
    return (
      webhookEvent.status === WebhookStatus.FAILED &&
      (isPendingWebhookTimeoutQuarantineMessage(webhookEvent.errorMessage) ||
        isTerminalWebhookTimeoutQuarantineMessage(webhookEvent.errorMessage))
    );
  }

  private normalizeBotId(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  private normalizeLowerString(value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }
}
