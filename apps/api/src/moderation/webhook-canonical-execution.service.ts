import {
  readFreshHeldCommandReceipt,
  freshHeldCommandTransitionSql,
} from '../webhook/webhook-legacy-fresh-command';
import { holdUnverifiedLegacyExecution } from '../webhook/webhook-legacy-authority';
import { settleOperatorDiscardedMirror } from '../webhook/webhook-operator-discard-mirror';
import {
  WebhookLegacyHoldService,
  legacyOrderReleasedSql,
  legacyUpdateHeldSql,
} from '../webhook/webhook-legacy-hold.service';
import { Injectable, Logger, Optional } from '@nestjs/common';
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
  WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINE_PREFIX,
} from '../webhook/webhook-timeout-quarantine';
import { WebhookOrderedPredecessorPendingError } from './webhook-ordered-predecessor-fence';
import { MaxExecutionOwnerReadinessService } from '../max/max-execution-owner-readiness.service';
import { executionRouteProof, type MaxExecutionRouteProof } from '../max/max-execution-route-proof';
import { WebhookPreparationDeferredError } from '../common/webhook-preparation-deferred.error';
import { WebhookExecutionOwnerUnavailableError } from '../common/webhook-execution-owner-unavailable.error';
import {
  buildWebhookExecutionDeadlineAt,
  hasExpiredWebhookReadinessWait,
  hasWebhookReplayFence,
  WEBHOOK_NO_EXECUTABLE_OWNER,
} from '../webhook/webhook-execution-deadline';
import { RuntimeDiagnosticsService } from '../system/runtime-diagnostics.service';
import {
  MULTIBOT_EXECUTION_AUTHORITY_VERSION,
  isEarlierWebhookReceipt,
} from '../webhook/webhook-semantic-authority';

export { WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX } from '../webhook/webhook-timeout-quarantine';

const WEBHOOK_CANONICAL_BUSINESS_LEASE_MS = 5 * 60_000;
// FLAG: Timeout persistence must tolerate a short database stall while remaining below the
// 60-second quarantine heartbeat and far below the lease and hard-settlement watchdog.
const WEBHOOK_TIMEOUT_PERSISTENCE_TRANSACTION_MAX_WAIT_MS = 10_000;
const WEBHOOK_TIMEOUT_PERSISTENCE_TRANSACTION_TIMEOUT_MS = 30_000;

type WebhookExecutionClaimRecord = {
  id?: string;
  kind?: string;
  semanticKey?: string;
  webhookEventId?: string | null;
  executionBotId?: string | null;
  enforced?: boolean;
  status?: string;
  preparedAt?: Date | null;
  completedAt?: Date | null;
  businessStartedAt?: Date | null;
  commandResult?: unknown;
  createdAt?: Date;
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
    findFirst?: unknown;
    findUnique?: (args: unknown) => Promise<{
      id: string;
      status: WebhookStatus;
      normalizedPayload: unknown;
      errorMessage: string | null;
      processedAt: Date | null;
      nextEnqueueAt: Date | null;
      timeoutQuarantineExpiresAt: Date | null;
      createdAt?: Date;
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
  kind: true,
  semanticKey: true,
  webhookEventId: true,
  executionBotId: true,
  enforced: true,
  status: true,
  preparedAt: true,
  completedAt: true,
  businessStartedAt: true,
  commandResult: true,
  createdAt: true,
  leaseToken: true,
  leaseExpiresAt: true,
} as const;

export type WebhookCanonicalExecutionContext = {
  freshHeldCommand?: boolean;
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

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly executionOwnerReadiness?: MaxExecutionOwnerReadinessService,
    @Optional() private readonly runtimeDiagnostics?: RuntimeDiagnosticsService,
    @Optional() private readonly legacyHolds?: WebhookLegacyHoldService,
  ) {}

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
      webhookEvent.status === WebhookStatus.NO_REPLAY_HELD ||
      webhookEvent.status === WebhookStatus.DUPLICATE ||
      webhookEvent.status === WebhookStatus.PROCESSED
    ) {
      return null;
    }
    const update = webhookEvent.normalizedPayload as MaxUpdate;
    const legacyHeld = await this.legacyHolds?.isUpdateHeld(update);
    const freshHeldCommand = legacyHeld
      ? await this.legacyHolds!.readFreshCommandReceipt(webhookEvent.id, update)
      : null;
    if (legacyHeld && !freshHeldCommand) {
      await this.legacyHolds!.settleHeldReceipt(webhookEvent.id, update);
      return null;
    }
    if (
      await settleOperatorDiscardedMirror(this.prisma, {
        webhookEventId: webhookEvent.id,
        update,
      })
    )
      return null;
    if (this.isHotPathTimeoutQuarantined(webhookEvent)) {
      const model = this.executionClaimModel;
      const finished =
        typeof model?.findFirst === 'function'
          ? await model.findFirst({
              where: { webhookEventId: webhookEvent.id, kind: 'EXECUTION' },
              select: WEBHOOK_EXECUTION_CLAIM_SELECT,
            })
          : null;
      if (
        finished?.businessStartedAt &&
        (await this.tryRecoverFinishedExecution(webhookEvent, finished))
      )
        return null;
      this.logger.warn(
        { webhookEventId: webhookEvent.id },
        'Skipped webhook execution that is quarantined after a hot-path timeout',
      );
      return null;
    }

    const normalizedUpdateType = update.type.trim().toLowerCase();
    const executionClaimModel = this.executionClaimModel;
    const semanticKey = buildWebhookSemanticEventKey(update);
    if (semanticKey && !webhookEvent.semanticKey) {
      await this.prisma.webhookEvent.updateMany({
        where: { id: webhookEvent.id, semanticKey: null },
        data: { semanticKey },
      });
      webhookEvent.semanticKey = semanticKey;
    }
    if (!webhookEvent.executionDeadlineAt) {
      const deadline = buildWebhookExecutionDeadlineAt(update, webhookEvent.createdAt);
      if (deadline) {
        await this.prisma.webhookEvent.updateMany({
          where: { id: webhookEvent.id, executionDeadlineAt: null },
          data: { executionDeadlineAt: deadline },
        });
        webhookEvent.executionDeadlineAt = deadline;
      }
    }
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
    let executionClaim =
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

    if (semanticKey) {
      if (!executionClaim?.id || !executionClaimModel?.updateMany)
        throw new WebhookPreparationDeferredError(
          'Semantic execution preparation authority missing',
          1_000,
        );
      if (
        await holdUnverifiedLegacyExecution(
          this.prisma,
          executionClaim as Parameters<typeof holdUnverifiedLegacyExecution>[1],
          webhookEvent,
        )
      ) {
        if (update.message?.chatId)
          await this.runtimeDiagnostics?.recordProblemChat({
            chatId: update.message.chatId,
            botId: executionClaim.executionBotId,
            category: 'canonical_recovery',
            severity: 'warning',
            reason: 'LEGACY_EXECUTION_UNVERIFIED; awaiting exact effects proof',
          });
        throw new WebhookPreparationDeferredError(
          'Legacy semantic execution requires exact proof recovery',
          5_000,
        );
      }
      if (executionClaim.enforced !== true) {
        const promoted = await executionClaimModel.updateMany({
          where: {
            id: executionClaim.id,
            webhookEventId: executionClaim.webhookEventId,
            status: executionClaim.status,
            enforced: false,
            leaseToken: executionClaim.leaseToken ?? null,
            leaseExpiresAt: executionClaim.leaseExpiresAt ?? null,
          },
          data: { enforced: true },
        });
        if (promoted.count !== 1)
          throw new WebhookPreparationDeferredError('Semantic execution authority changed', 1_000);
        executionClaim = { ...executionClaim, enforced: true };
      }
    }

    if (executionClaim?.webhookEventId === null) {
      const settled = await this.prisma.$transaction((tx) =>
        WebhookCanonicalExecutionService.trySettleCompletedShadowMirrorWithClient(
          tx as unknown as WebhookCanonicalPersistenceClient,
          { webhookEvent, update, businessLeaseToken: null },
          {
            id: webhookEvent.id,
            status: webhookEvent.status,
            errorMessage: webhookEvent.errorMessage,
            timeoutQuarantineExpiresAt: null,
          },
        ),
      );
      if (settled !== 'settled')
        throw new WebhookPreparationDeferredError(
          'Ownerless semantic authority cannot execute',
          1_000,
        );
      return null;
    }

    if (
      executionClaim?.enforced === true &&
      executionClaim.webhookEventId &&
      executionClaim.webhookEventId !== webhookEvent.id
    ) {
      const settlement = await this.prisma.$transaction((tx) =>
        WebhookCanonicalExecutionService.trySettlePreparedMirrorWithClient(
          tx as unknown as WebhookCanonicalPersistenceClient,
          { webhookEvent, update, businessLeaseToken: null },
          {
            id: webhookEvent.id,
            status: webhookEvent.status,
            errorMessage: webhookEvent.errorMessage,
            timeoutQuarantineExpiresAt: null,
          },
        ),
      );
      if (settlement !== 'settled')
        throw new WebhookPreparationDeferredError(
          `Canonical mirror awaits semantic owner (${MULTIBOT_EXECUTION_AUTHORITY_VERSION})`,
          1_000,
        );
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
      if (
        executionClaim.semanticKey !== semanticKey ||
        !(executionClaim.preparedAt instanceof Date) ||
        !Number.isFinite(executionClaim.preparedAt.getTime()) ||
        !(executionClaim.completedAt instanceof Date) ||
        !Number.isFinite(executionClaim.completedAt.getTime()) ||
        executionClaim.leaseToken !== null ||
        executionClaim.leaseExpiresAt !== null ||
        hasWebhookReplayFence(webhookEvent)
      )
        throw new WebhookPreparationDeferredError('Completed execution proof incomplete', 1_000);
      const completedClaim = executionClaim;
      await this.prisma.$transaction(async (tx) => {
        const authority = await tx.webhookExecutionClaim.updateMany({
          where: {
            id: completedClaim.id,
            kind: 'EXECUTION',
            semanticKey: semanticKey!,
            webhookEventId: webhookEvent.id,
            enforced: true,
            status: 'COMPLETED',
            preparedAt: completedClaim.preparedAt,
            completedAt: completedClaim.completedAt,
            leaseToken: null,
            leaseExpiresAt: null,
          },
          data: { enforced: true },
        });
        if (authority.count !== 1)
          throw new WebhookPreparationDeferredError('Completed execution claim changed', 1_000);
        const receipt = await tx.webhookEvent.updateMany({
          where: {
            id: webhookEvent.id,
            status: webhookEvent.status,
            normalizedPayload: { equals: webhookEvent.normalizedPayload as Prisma.InputJsonValue },
            errorMessage: webhookEvent.errorMessage,
            nextEnqueueAt: webhookEvent.nextEnqueueAt,
            timeoutQuarantineExpiresAt: null,
          },
          data: {
            status: WebhookStatus.PROCESSED,
            processedAt: completedClaim.completedAt,
            queueName: null,
            errorMessage: null,
            nextEnqueueAt: null,
          },
        });
        if (receipt.count !== 1)
          throw new WebhookPreparationDeferredError('Completed execution receipt changed', 1_000);
      });
      return null;
    }

    if (executionClaim?.businessStartedAt) {
      if (await this.tryRecoverFinishedExecution(webhookEvent, executionClaim)) return null;
      if (
        executionClaim.leaseToken &&
        executionClaim.leaseExpiresAt &&
        executionClaim.leaseExpiresAt.getTime() > Date.now()
      )
        throw new WebhookPreparationDeferredError('Canonical business already running', 1_000);
      // FLAG: A started whole-engine attempt is never reclaimed, including by the same
      // bot. Its independent durable action/media/command journals recover existing work;
      // this receipt retains the ordered replay fence until exact proof recovery settles it.
      await this.prisma.webhookEvent.updateMany({
        where: {
          id: webhookEvent.id,
          status: webhookEvent.status,
          errorMessage: webhookEvent.errorMessage,
          timeoutQuarantineExpiresAt: null,
        },
        data: {
          status: WebhookStatus.FAILED,
          errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:CANONICAL_BUSINESS_ALREADY_STARTED; durable-effects recovery required`,
          nextEnqueueAt: null,
          queueName: null,
        },
      });
      if (update.message?.chatId)
        await this.runtimeDiagnostics?.recordProblemChat({
          chatId: update.message.chatId,
          botId: executionClaim.executionBotId,
          category: 'canonical_recovery',
          severity: 'warning',
          reason: 'CANONICAL_BUSINESS_ALREADY_STARTED; awaiting durable-effects proof',
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
      freshHeldCommand: freshHeldCommand !== null,
      webhookEvent,
      update,
      activeBotId:
        this.normalizeBotId(executionClaim?.executionBotId) ??
        this.normalizeBotId(webhookEvent.botId) ??
        this.normalizeBotId(update.botId) ??
        this.normalizeBotId(defaultBotId),
      businessLeaseToken,
    };
    let preparedProof: MaxExecutionRouteProof | null = null;

    if (businessLeaseToken && this.executionOwnerReadiness && update.message?.chatId) {
      try {
        if (
          semanticKey &&
          hasExpiredWebhookReadinessWait(
            executionClaim?.commandResult,
            webhookEvent.id,
            semanticKey,
            webhookEvent.executionDeadlineAt,
          )
        ) {
          const expired = await this.prisma.$transaction((tx) =>
            WebhookCanonicalExecutionService.tryExpireUnstartedOwnerWithClient(tx, {
              webhookEventId: webhookEvent.id,
              semanticKey,
              claimId: executionClaim!.id!,
              leaseToken: businessLeaseToken,
            }),
          );
          if (!expired)
            throw new WebhookPreparationDeferredError(
              'Expired executor waiting authority changed',
              1_000,
            );
          await this.runtimeDiagnostics?.recordProblemChat({
            chatId: update.message.chatId,
            botId: context.activeBotId,
            category: 'executor_readiness',
            severity: 'warning',
            reason: `${WEBHOOK_NO_EXECUTABLE_OWNER}; deadline=${webhookEvent.executionDeadlineAt!.toISOString()}`,
          });
          return null;
        }
        const proof = await this.executionOwnerReadiness.ensureReady({
          chatId: update.message.chatId,
          preferredBotId: context.activeBotId,
        });
        if (!proof)
          throw new WebhookExecutionOwnerUnavailableError('No eligible moderation executor', 5_000);
        preparedProof = proof;
      } catch (error: unknown) {
        if (
          error instanceof WebhookExecutionOwnerUnavailableError &&
          webhookEvent.executionDeadlineAt &&
          semanticKey
        )
          await this.prisma.webhookExecutionClaim.updateMany({
            where: {
              id: executionClaim!.id,
              webhookEventId: webhookEvent.id,
              kind: 'EXECUTION',
              status: 'READY',
              leaseToken: businessLeaseToken,
              businessStartedAt: null,
            },
            data: {
              commandResult: {
                kind: 'EXECUTION_WAITING',
                authorityVersion: MULTIBOT_EXECUTION_AUTHORITY_VERSION,
                webhookEventId: webhookEvent.id,
                semanticKey,
                deadlineAt: webhookEvent.executionDeadlineAt.toISOString(),
              },
            },
          });
        if (
          error instanceof WebhookExecutionOwnerUnavailableError &&
          webhookEvent.executionDeadlineAt &&
          webhookEvent.executionDeadlineAt.getTime() <= Date.now() &&
          semanticKey
        ) {
          const expired = await this.prisma.$transaction((tx) =>
            WebhookCanonicalExecutionService.tryExpireUnstartedOwnerWithClient(tx, {
              webhookEventId: webhookEvent.id,
              semanticKey,
              claimId: executionClaim!.id!,
              leaseToken: businessLeaseToken,
            }),
          );
          if (expired) {
            await this.runtimeDiagnostics?.recordProblemChat({
              chatId: update.message.chatId,
              botId: context.activeBotId,
              category: 'executor_readiness',
              severity: 'warning',
              reason: `${WEBHOOK_NO_EXECUTABLE_OWNER}; deadline=${webhookEvent.executionDeadlineAt.toISOString()}`,
            });
            return null;
          }
        }
        await this.releaseBusinessLease(context);
        throw error;
      }
    }

    // Recheck after a fenced claim: another worker can have read this event before a timeout
    // quarantine was persisted, then win the claim after its original owner finishes.
    if (businessLeaseToken) {
      const latestWebhookEvent = await this.prisma.webhookEvent.findUnique({
        where: { id: webhookEvent.id },
      });
      if (
        !latestWebhookEvent ||
        latestWebhookEvent.status === WebhookStatus.NO_REPLAY_HELD ||
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

    if (businessLeaseToken) {
      let started: 'transitioned' | 'expired' | 'deferred';
      try {
        started = preparedProof
          ? await this.adoptPreparedExecutor(context, executionClaim!, preparedProof)
          : await this.prisma.$transaction((tx) =>
              WebhookCanonicalExecutionService.transitionLiveUnstartedOwnerWithClient(tx, {
                claimId: executionClaim!.id!,
                webhookEventId: webhookEvent.id,
                semanticKey: executionClaim!.semanticKey!,
                leaseToken: businessLeaseToken,
                executionBotId: executionClaim!.executionBotId ?? null,
                executionDeadlineAt: webhookEvent.executionDeadlineAt,
                enforced: true,
                phase: 'start',
                checkFreshHeldCommand: context.freshHeldCommand,
              }),
            );
      } catch (error: unknown) {
        await this.releaseBusinessLease(context);
        throw error;
      }
      if (started === 'expired') {
        await this.runtimeDiagnostics?.recordProblemChat({
          chatId: update.message!.chatId,
          botId: context.activeBotId,
          category: 'executor_readiness',
          severity: 'warning',
          reason: `${WEBHOOK_NO_EXECUTABLE_OWNER}; deadline=${webhookEvent.executionDeadlineAt!.toISOString()}`,
        });
        return null;
      }
      if (started !== 'transitioned') {
        await this.releaseBusinessLease(context);
        throw new WebhookPreparationDeferredError('Canonical business-start fence changed', 1_000);
      }
    }
    return context;
  }

  static async transitionLiveUnstartedOwnerWithClient(
    client: Prisma.TransactionClient,
    params: {
      claimId: string;
      webhookEventId: string;
      semanticKey: string;
      leaseToken: string;
      executionBotId: string | null;
      expectedExecutionBotId?: string | null;
      executionDeadlineAt: Date | null;
      enforced: boolean;
      phase: 'ready' | 'start';
      checkFreshHeldCommand?: boolean;
      route?: { chatId: string; proof: MaxExecutionRouteProof };
    },
  ): Promise<'transitioned' | 'expired' | 'deferred'> {
    // FLAG: Acquire both row locks before reading the database clock. A WHERE evaluated before
    // waiting for an UPDATE lock can otherwise accept a lease/deadline that expires in that wait.
    await client.$queryRaw(Prisma.sql`
      SELECT "id" FROM "webhook_execution_claims" WHERE "id" = ${params.claimId} FOR UPDATE
    `);
    await client.$queryRaw(Prisma.sql`
      SELECT "id" FROM "webhook_events" WHERE "id" = ${params.webhookEventId} FOR UPDATE
    `);
    const freshHeldCommand = params.checkFreshHeldCommand
      ? await readFreshHeldCommandReceipt(client, params.webhookEventId)
      : null;
    const waitingMarker = JSON.stringify({
      kind: 'EXECUTION_WAITING',
      authorityVersion: MULTIBOT_EXECUTION_AUTHORITY_VERSION,
      webhookEventId: params.webhookEventId,
      semanticKey: params.semanticKey,
      deadlineAt: params.executionDeadlineAt?.toISOString() ?? null,
    });
    const routeFence = params.route
      ? Prisma.sql`AND EXISTS (
          SELECT 1 FROM "chats" AS chat
          JOIN "chat_bot_memberships" AS membership ON membership."chat_id" = chat."id"
          WHERE chat."id" = ${params.route.chatId}
            AND chat."primary_bot_id" = ${params.route.proof.botId}
            AND chat."routing_version" = ${params.route.proof.routingVersion}
            AND membership."bot_id" = ${params.route.proof.botId}
            AND membership."status" = 'ACTIVE'
            AND membership."bot_access_state" IN ('CONFIRMED_ADMIN', 'CONFIRMED_OWNER')
            AND membership."bot_access_checked_at" = ${params.route.proof.accessEpoch.checkedAt}
            AND membership."bot_access_source" = ${params.route.proof.accessEpoch.source}
            AND membership."bot_access_checked_at" <= instant."now"
            AND membership."bot_access_checked_at" + INTERVAL '5 minutes' > instant."now"
            AND membership."bot_access_expires_at" > instant."now"
        )`
      : Prisma.empty;
    const executionBotFence =
      params.expectedExecutionBotId !== undefined
        ? Prisma.sql`AND claim."execution_bot_id" IS NOT DISTINCT FROM ${params.expectedExecutionBotId}`
        : Prisma.empty;
    const ready = params.phase === 'ready';
    const changed = await client.$executeRaw(Prisma.sql`
      WITH instant AS MATERIALIZED (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now")
      UPDATE "webhook_execution_claims" AS claim
      SET "execution_bot_id" = ${params.executionBotId},
          "enforced" = claim."enforced" OR ${params.enforced},
          "status" = 'READY',
          "prepared_at" = ${ready ? Prisma.sql`instant."now"` : Prisma.sql`claim."prepared_at"`},
          "business_started_at" = ${ready ? Prisma.sql`NULL` : Prisma.sql`instant."now"`},
          "lease_token" = ${ready ? Prisma.sql`NULL` : Prisma.sql`claim."lease_token"`},
          "lease_expires_at" = ${ready ? Prisma.sql`NULL` : Prisma.sql`claim."lease_expires_at"`},
          "updated_at" = instant."now"
      FROM "webhook_events" AS event, instant
      WHERE claim."id" = ${params.claimId} AND claim."kind" = 'EXECUTION'
        AND claim."semantic_key" = ${params.semanticKey}
        AND claim."webhook_event_id" = event."id" AND event."id" = ${params.webhookEventId}
        AND event."legacy_disposition_id" IS NULL
        AND (NOT ${legacyUpdateHeldSql('event')} OR ${freshHeldCommandTransitionSql('event', freshHeldCommand)})
        AND claim."status"::text = ${ready ? 'PENDING' : 'READY'}
        AND claim."completed_at" IS NULL AND claim."business_started_at" IS NULL
        AND claim."lease_token" = ${params.leaseToken}
        AND claim."lease_expires_at" > instant."now"
        AND (${ready} OR claim."enforced")
        AND event."status" NOT IN ('PROCESSED', 'DUPLICATE', 'NO_REPLAY_HELD')
        AND event."timeout_quarantine_expires_at" IS NULL
        AND COALESCE(event."error_message", '') NOT LIKE ${`${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}%`}
        AND COALESCE(event."error_message", '') NOT LIKE ${`${WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINE_PREFIX}%`}
        AND COALESCE(event."error_message", '') NOT ILIKE '%ambiguous%'
        AND event."execution_deadline_at" IS NOT DISTINCT FROM ${params.executionDeadlineAt}
        AND (NOT COALESCE(claim."command_result" @> ${waitingMarker}::jsonb, false)
             OR event."execution_deadline_at" > instant."now")
        ${executionBotFence} ${routeFence}
    `);
    if (changed === 1) return 'transitioned';
    return (await WebhookCanonicalExecutionService.tryExpireUnstartedOwnerWithClient(
      client,
      params,
    ))
      ? 'expired'
      : 'deferred';
  }

  static async tryExpireUnstartedOwnerWithClient(
    client: Prisma.TransactionClient,
    params: { webhookEventId: string; semanticKey: string; claimId: string; leaseToken: string },
  ): Promise<boolean> {
    await client.$queryRaw(Prisma.sql`
      SELECT "id" FROM "webhook_execution_claims" WHERE "id" = ${params.claimId} FOR UPDATE
    `);
    await client.$queryRaw(Prisma.sql`
      SELECT "id" FROM "webhook_events" WHERE "id" = ${params.webhookEventId} FOR UPDATE
    `);
    const now = new Date();
    const event = await client.webhookEvent.findUnique({ where: { id: params.webhookEventId } });
    const claim = await client.webhookExecutionClaim.findUnique({ where: { id: params.claimId } });
    if (
      !event ||
      !claim ||
      claim.kind !== 'EXECUTION' ||
      !claim.enforced ||
      claim.semanticKey !== params.semanticKey ||
      claim.webhookEventId !== event.id ||
      claim.leaseToken !== params.leaseToken ||
      claim.businessStartedAt !== null ||
      claim.status === 'COMPLETED' ||
      !event.executionDeadlineAt ||
      event.executionDeadlineAt.getTime() > now.getTime() ||
      hasWebhookReplayFence(event) ||
      event.status === WebhookStatus.NO_REPLAY_HELD ||
      event.status === WebhookStatus.PROCESSED ||
      event.status === WebhookStatus.DUPLICATE ||
      buildWebhookSemanticEventKey(event.normalizedPayload) !== params.semanticKey
    )
      return false;
    // FLAG: Expiry is a proven no-business disposition, not an access grant or a success
    // receipt. Its exact existing claim completes so late mirrors cannot replay the event.
    const waitingMarker = JSON.stringify({
      kind: 'EXECUTION_WAITING',
      authorityVersion: MULTIBOT_EXECUTION_AUTHORITY_VERSION,
      webhookEventId: event.id,
      semanticKey: params.semanticKey,
      deadlineAt: event.executionDeadlineAt.toISOString(),
    });
    const fenced = await client.$executeRaw(Prisma.sql`
      WITH instant AS MATERIALIZED (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now")
      UPDATE "webhook_execution_claims" AS claim
      SET "status" = 'COMPLETED', "prepared_at" = COALESCE(claim."prepared_at", instant."now"),
          "completed_at" = instant."now", "lease_token" = NULL, "lease_expires_at" = NULL,
          "updated_at" = instant."now"
      FROM "webhook_events" AS event, instant
      WHERE claim."id" = ${claim.id} AND claim."kind" = 'EXECUTION'
        AND claim."semantic_key" = ${params.semanticKey}
        AND claim."webhook_event_id" = event."id" AND event."id" = ${event.id}
        AND claim."status"::text = ${claim.status} AND claim."enforced"
        AND claim."lease_token" = ${params.leaseToken} AND claim."lease_expires_at" > instant."now"
        AND claim."business_started_at" IS NULL AND claim."completed_at" IS NULL
        AND claim."command_result" @> ${waitingMarker}::jsonb
        AND event."execution_deadline_at" = ${event.executionDeadlineAt}
        AND event."execution_deadline_at" <= instant."now"
    `);
    if (fenced !== 1) return false;
    const payload = {
      ...(event.normalizedPayload as unknown as MaxUpdate),
      executionOutcome: {
        code: WEBHOOK_NO_EXECUTABLE_OWNER,
        deadlineAt: event.executionDeadlineAt.toISOString(),
      },
    };
    const settled = await client.webhookEvent.updateMany({
      where: {
        id: event.id,
        status: event.status,
        normalizedPayload: { equals: event.normalizedPayload as Prisma.InputJsonValue },
        executionDeadlineAt: event.executionDeadlineAt,
        errorMessage: event.errorMessage,
        nextEnqueueAt: event.nextEnqueueAt,
        timeoutQuarantineExpiresAt: null,
      },
      data: {
        status: WebhookStatus.PROCESSED,
        normalizedPayload: payload as unknown as Prisma.InputJsonValue,
        processedAt: now,
        queueName: null,
        nextEnqueueAt: null,
        errorMessage: null,
      },
    });
    if (settled.count !== 1)
      throw new WebhookPreparationDeferredError('Executor expiry receipt changed', 1_000);
    return true;
  }

  private async adoptPreparedExecutor(
    context: WebhookCanonicalExecutionContext,
    claim: WebhookExecutionClaimRecord,
    accepted: MaxExecutionRouteProof,
  ): Promise<'transitioned' | 'expired' | 'deferred'> {
    const chatId = context.update.message!.chatId;
    return this.prisma.$transaction(async (tx) => {
      // FLAG: Adopt and start together under the live SQL lease and original readiness deadline.
      // The receipt, order anchor and all downstream action/deadline identities stay unchanged.
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "chats" WHERE "id" = ${chatId} FOR UPDATE`);
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "chat_bot_memberships"
        WHERE "chat_id" = ${chatId} AND "bot_id" = ${accepted.botId} FOR UPDATE
      `);
      const chat = await tx.chat.findUnique({
        where: { id: chatId },
        select: {
          primaryBotId: true,
          routingVersion: true,
          entityType: true,
          botMemberships: {
            select: {
              botId: true,
              status: true,
              botAccessState: true,
              botAccessCheckedAt: true,
              botAccessExpiresAt: true,
              botAccessSource: true,
              permissionsSnapshot: true,
            },
          },
        },
      });
      const proof = chat
        ? executionRouteProof(
            {
              chatId,
              entityType: chat.entityType,
              primaryBotId: chat.primaryBotId,
              routingVersion: chat.routingVersion,
              candidates: chat.botMemberships,
            },
            accepted.botId,
          )
        : null;
      if (
        !proof ||
        chat!.primaryBotId !== accepted.botId ||
        proof.routingVersion !== accepted.routingVersion ||
        proof.accessEpoch.checkedAt.getTime() !== accepted.accessEpoch.checkedAt.getTime() ||
        proof.accessEpoch.source !== accepted.accessEpoch.source
      )
        throw new WebhookPreparationDeferredError(
          'Execution route proof changed before business',
          1_000,
        );
      const changed = await WebhookCanonicalExecutionService.transitionLiveUnstartedOwnerWithClient(
        tx,
        {
          claimId: claim.id!,
          webhookEventId: context.webhookEvent.id,
          semanticKey: claim.semanticKey!,
          leaseToken: context.businessLeaseToken!,
          executionBotId: accepted.botId,
          expectedExecutionBotId: claim.executionBotId ?? null,
          executionDeadlineAt: context.webhookEvent.executionDeadlineAt,
          enforced: true,
          phase: 'start',
          checkFreshHeldCommand: context.freshHeldCommand,
          route: { chatId, proof: accepted },
        },
      );
      if (changed !== 'transitioned') return changed;
      const nextUpdate = { ...context.update, executionOwnerBotId: accepted.botId };
      const receipt = await tx.webhookEvent.updateMany({
        where: {
          id: context.webhookEvent.id,
          normalizedPayload: {
            equals: context.webhookEvent.normalizedPayload as Prisma.InputJsonValue,
          },
          status: { in: [WebhookStatus.RECEIVED, WebhookStatus.QUEUED, WebhookStatus.FAILED] },
          timeoutQuarantineExpiresAt: null,
        },
        data: { normalizedPayload: nextUpdate as unknown as Prisma.InputJsonValue },
      });
      if (receipt.count !== 1)
        throw new WebhookPreparationDeferredError(
          'Execution receipt changed before business',
          1_000,
        );
      context.update = nextUpdate;
      context.webhookEvent.normalizedPayload = nextUpdate as unknown as Prisma.JsonValue;
      context.activeBotId = accepted.botId;
      return 'transitioned';
    });
  }

  async completeExecution(context: WebhookCanonicalExecutionContext): Promise<void> {
    // FLAG: This method is called only after the awaited whole handler succeeds. Persist
    // that exact fact before receipt settlement, so a crash here never reruns the engine.
    await this.markExecutionHandlerFinished(context);
    if (context.businessLeaseToken) {
      await this.prisma.$transaction(async (tx) => {
        const claim = await tx.webhookExecutionClaim.findFirst({
          where: { webhookEventId: context.webhookEvent.id, kind: 'EXECUTION' },
        });
        const journal = claim ? this.finishedExecutionJournal(context.webhookEvent, claim) : null;
        if (!claim || !journal)
          throw new WebhookPreparationDeferredError('Completed handler journal unavailable', 1_000);
        if (
          claim.status === 'COMPLETED' &&
          claim.leaseToken === null &&
          claim.leaseExpiresAt === null
        )
          return;
        if (claim.status !== 'READY' || claim.leaseToken !== context.businessLeaseToken)
          throw new WebhookPreparationDeferredError('Handler completion lease changed', 1_000);
        const completed = await tx.webhookExecutionClaim.updateMany({
          where: {
            id: claim.id,
            kind: 'EXECUTION',
            webhookEventId: context.webhookEvent.id,
            status: 'READY',
            enforced: true,
            leaseToken: context.businessLeaseToken,
            businessStartedAt: claim.businessStartedAt,
            commandResult: { equals: journal as Prisma.InputJsonValue },
          },
          data: {
            status: 'COMPLETED',
            completedAt: new Date(journal.finishedAt as string),
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        if (completed.count !== 1)
          throw new WebhookPreparationDeferredError('Handler completion claim changed', 1_000);
        const settled = await tx.webhookEvent.updateMany({
          where: {
            id: context.webhookEvent.id,
            status: context.webhookEvent.status,
            normalizedPayload: {
              equals: context.webhookEvent.normalizedPayload as Prisma.InputJsonValue,
            },
            errorMessage: context.webhookEvent.errorMessage,
            timeoutQuarantineExpiresAt: null,
          },
          data: {
            status: WebhookStatus.PROCESSED,
            processedAt: new Date(journal.finishedAt as string),
            errorMessage: null,
            queueName: null,
            nextEnqueueAt: null,
          },
        });
        if (settled.count !== 1)
          throw new WebhookPreparationDeferredError('Handler completion receipt changed', 1_000);
      });
      return;
    }
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

  private async markExecutionHandlerFinished(
    context: WebhookCanonicalExecutionContext,
  ): Promise<void> {
    if (!context.businessLeaseToken) return;
    await this.prisma.$transaction(async (tx) => {
      const claim = await tx.webhookExecutionClaim.findFirst({
        where: { webhookEventId: context.webhookEvent.id, kind: 'EXECUTION' },
      });
      if (
        claim &&
        this.finishedExecutionJournal(context.webhookEvent, claim) &&
        claim.executionBotId === context.activeBotId
      )
        return;
      if (
        !claim ||
        claim.status !== 'READY' ||
        !claim.enforced ||
        claim.leaseToken !== context.businessLeaseToken ||
        !claim.businessStartedAt ||
        claim.executionBotId !== context.activeBotId
      )
        throw new WebhookPreparationDeferredError(
          'Handler-finished execution lease changed',
          1_000,
        );
      const receipt = await tx.webhookEvent.updateMany({
        where: {
          id: context.webhookEvent.id,
          normalizedPayload: {
            equals: context.webhookEvent.normalizedPayload as Prisma.InputJsonValue,
          },
          status: context.webhookEvent.status,
          errorMessage: context.webhookEvent.errorMessage,
          timeoutQuarantineExpiresAt: null,
        },
        data: { status: context.webhookEvent.status },
      });
      if (receipt.count !== 1)
        throw new WebhookPreparationDeferredError('Handler-finished source receipt changed', 1_000);
      const journal = {
        kind: 'EXECUTION_FINISHED',
        authorityVersion: MULTIBOT_EXECUTION_AUTHORITY_VERSION,
        webhookEventId: claim.webhookEventId,
        semanticKey: claim.semanticKey,
        executionBotId: claim.executionBotId,
        businessStartedAt: claim.businessStartedAt.toISOString(),
        finishedAt: new Date().toISOString(),
      };
      const recorded = await tx.webhookExecutionClaim.updateMany({
        where: {
          id: claim.id,
          kind: 'EXECUTION',
          webhookEventId: context.webhookEvent.id,
          status: 'READY',
          enforced: true,
          leaseToken: context.businessLeaseToken,
          businessStartedAt: claim.businessStartedAt,
          executionBotId: claim.executionBotId,
        },
        data: { commandResult: journal },
      });
      if (recorded.count !== 1)
        throw new WebhookPreparationDeferredError('Handler-finished journal changed', 1_000);
    });
  }

  private async tryRecoverFinishedExecution(
    event: WebhookEvent,
    claim: WebhookExecutionClaimRecord,
  ): Promise<boolean> {
    return this.prisma.$transaction((tx) =>
      WebhookCanonicalExecutionService.tryRecoverFinishedExecutionWithClient(
        tx as unknown as WebhookCanonicalPersistenceClient,
        event,
        claim,
      ),
    );
  }

  // FLAG: Only the original handler's exact saved checkpoint authorizes this SQL-only
  // settlement. A live or expired lease without that checkpoint never proves completion.
  // This certifies the finished handler, not current content or new remote effects; existing
  // independent action/delete/media journals retain their own authority and snapshots.
  // The caller owns the transaction: a receipt CAS loss must roll back claim completion.
  static async tryRecoverFinishedExecutionWithClient(
    client: WebhookCanonicalPersistenceClient,
    event: WebhookEvent,
    claim: WebhookExecutionClaimRecord,
  ): Promise<boolean> {
    const result = this.finishedExecutionJournal(event, claim);
    const semanticKey = buildWebhookSemanticEventKey(event.normalizedPayload);
    if (
      !result ||
      !claim.id ||
      (event.status !== WebhookStatus.RECEIVED &&
        event.status !== WebhookStatus.QUEUED &&
        event.status !== WebhookStatus.FAILED) ||
      event.processedAt !== null ||
      event.semanticKey !== semanticKey ||
      claim.status !== 'READY' ||
      claim.completedAt !== null ||
      !client.webhookExecutionClaim?.updateMany ||
      (claim.leaseToken !== null &&
        (typeof claim.leaseToken !== 'string' || !claim.leaseToken.trim())) ||
      (claim.leaseExpiresAt !== null &&
        (!(claim.leaseExpiresAt instanceof Date) ||
          !Number.isFinite(claim.leaseExpiresAt.getTime()))) ||
      (claim.leaseToken === null) !== (claim.leaseExpiresAt === null)
    )
      return false;
    // The checkpoint certifies only the original finished handler. Recovery performs SQL
    // settlement and retains its attribution; it cannot run a new rule, send or sanction.
    const completed = await client.webhookExecutionClaim.updateMany({
      where: {
        id: claim.id,
        kind: 'EXECUTION',
        webhookEventId: event.id,
        semanticKey: semanticKey!,
        status: 'READY',
        enforced: true,
        executionBotId: claim.executionBotId,
        preparedAt: claim.preparedAt,
        completedAt: null,
        leaseToken: claim.leaseToken,
        leaseExpiresAt: claim.leaseExpiresAt,
        businessStartedAt: claim.businessStartedAt,
        commandResult: { equals: result as Prisma.InputJsonValue },
      },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(result.finishedAt as string),
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    if (completed.count !== 1) return false;
    const settled = await client.webhookEvent.updateMany({
      where: {
        id: event.id,
        botId: event.botId,
        dedupKey: event.dedupKey,
        sourceIp: event.sourceIp,
        createdAt: event.createdAt,
        status: event.status,
        semanticKey: event.semanticKey,
        rawPayload: { equals: event.rawPayload as Prisma.InputJsonValue },
        normalizedPayload: { equals: event.normalizedPayload as Prisma.InputJsonValue },
        processedAt: event.processedAt,
        queueName: event.queueName,
        queuedAt: event.queuedAt,
        enqueueAttempts: event.enqueueAttempts,
        nextEnqueueAt: event.nextEnqueueAt,
        executionDeadlineAt: event.executionDeadlineAt,
        errorMessage: event.errorMessage,
        timeoutQuarantineExpiresAt: event.timeoutQuarantineExpiresAt,
      },
      data: {
        status: WebhookStatus.PROCESSED,
        processedAt: new Date(result.finishedAt as string),
        errorMessage: null,
        queueName: null,
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
      },
    });
    if (settled.count !== 1)
      throw new WebhookPreparationDeferredError('Finished-handler receipt recovery changed', 1_000);
    return true;
  }

  private finishedExecutionJournal(
    event: Pick<WebhookEvent, 'id' | 'normalizedPayload'>,
    claim: WebhookExecutionClaimRecord,
  ): Record<string, unknown> | null {
    return WebhookCanonicalExecutionService.finishedExecutionJournal(event, claim);
  }

  private static finishedExecutionJournal(
    event: Pick<WebhookEvent, 'id' | 'normalizedPayload'>,
    claim: WebhookExecutionClaimRecord,
  ): Record<string, unknown> | null {
    const result = claim.commandResult as Record<string, unknown> | null;
    const semanticKey = buildWebhookSemanticEventKey(event.normalizedPayload);
    if (
      !semanticKey ||
      claim.kind !== 'EXECUTION' ||
      claim.enforced !== true ||
      claim.webhookEventId !== event.id ||
      claim.semanticKey !== semanticKey ||
      (claim.executionBotId !== null &&
        (typeof claim.executionBotId !== 'string' || !claim.executionBotId.trim())) ||
      !(claim.preparedAt instanceof Date) ||
      !Number.isFinite(claim.preparedAt.getTime()) ||
      !(claim.businessStartedAt instanceof Date) ||
      !Number.isFinite(claim.businessStartedAt.getTime()) ||
      !result ||
      result.kind !== 'EXECUTION_FINISHED' ||
      result.authorityVersion !== MULTIBOT_EXECUTION_AUTHORITY_VERSION ||
      result.webhookEventId !== event.id ||
      result.semanticKey !== semanticKey ||
      result.executionBotId !== claim.executionBotId ||
      result.businessStartedAt !== claim.businessStartedAt.toISOString() ||
      typeof result.finishedAt !== 'string' ||
      !Number.isFinite(Date.parse(result.finishedAt)) ||
      Date.parse(result.finishedAt) < claim.businessStartedAt.getTime()
    )
      return null;
    return result;
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
    await this.prisma.webhookEvent.updateMany({
      where: {
        id: context.webhookEvent.id,
        status: {
          notIn: [WebhookStatus.PROCESSED, WebhookStatus.DUPLICATE, WebhookStatus.NO_REPLAY_HELD],
        },
        executionClaims: { none: { kind: 'EXECUTION', status: 'COMPLETED' } },
      },
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

  static async trySettlePreparedMirrorWithClient(
    client: WebhookCanonicalPersistenceClient,
    context: WebhookShadowMirrorSettlementContext,
    mirrorWhere: Prisma.WebhookEventWhereInput,
  ): Promise<WebhookShadowMirrorSettlementResult> {
    if (context.businessLeaseToken !== null) return 'invalid';
    const semanticKey = buildWebhookSemanticEventKey(context.update);
    if (
      !semanticKey ||
      !client.webhookExecutionClaim?.findUnique ||
      !client.webhookExecutionClaim.updateMany ||
      !client.webhookEvent.findUnique
    )
      return 'invalid';
    const claim = await client.webhookExecutionClaim.findUnique({
      where: { kind_semanticKey: { kind: 'EXECUTION', semanticKey } },
      select: WEBHOOK_EXECUTION_CLAIM_SELECT,
    });
    if (
      !claim?.id ||
      !claim.webhookEventId ||
      claim.webhookEventId === context.webhookEvent.id ||
      claim.semanticKey !== semanticKey ||
      claim.enforced !== true
    )
      return 'invalid';
    if (claim.status === 'COMPLETED')
      return this.trySettleCompletedShadowMirrorWithClient(client, context, mirrorWhere);
    if (claim.status !== 'READY' || !(claim.preparedAt instanceof Date)) return 'retry';
    const select = {
      id: true,
      status: true,
      normalizedPayload: true,
      createdAt: true,
      processedAt: true,
      errorMessage: true,
      nextEnqueueAt: true,
      timeoutQuarantineExpiresAt: true,
    };
    const mirror = await client.webhookEvent.findUnique({
      where: { id: context.webhookEvent.id },
      select,
    });
    const owner = await client.webhookEvent.findUnique({
      where: { id: claim.webhookEventId },
      select,
    });
    if (
      !mirror ||
      !owner ||
      !(mirror.createdAt instanceof Date) ||
      !(owner.createdAt instanceof Date) ||
      buildWebhookSemanticEventKey(mirror.normalizedPayload) !== semanticKey ||
      buildWebhookSemanticEventKey(owner.normalizedPayload) !== semanticKey
    )
      return 'invalid';
    // FLAG: An earlier mirror remains the ordered proxy until the owner completes. Settling
    // it at READY would allow an interleaved distinct message to overtake the canonical work.
    if (
      await isEarlierWebhookReceipt(
        client,
        mirror as { id: string; createdAt: Date },
        owner as { id: string; createdAt: Date },
      )
    )
      return 'retry';
    if (
      owner.timeoutQuarantineExpiresAt !== null ||
      mirror.timeoutQuarantineExpiresAt !== null ||
      [owner.errorMessage, mirror.errorMessage].some(
        (message) =>
          message?.startsWith(WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX) ||
          message?.toLowerCase().includes('ambiguous'),
      )
    )
      return 'invalid';
    if (
      owner.status !== WebhookStatus.RECEIVED &&
      owner.status !== WebhookStatus.QUEUED &&
      !(owner.status === WebhookStatus.FAILED && owner.nextEnqueueAt instanceof Date)
    )
      return 'retry';
    const ownerFence = await client.webhookEvent.updateMany({
      where: {
        id: owner.id,
        status: owner.status,
        nextEnqueueAt: owner.nextEnqueueAt,
        errorMessage: owner.errorMessage,
        timeoutQuarantineExpiresAt: null,
        normalizedPayload: { equals: owner.normalizedPayload as Prisma.InputJsonValue },
      },
      data: { status: owner.status },
    });
    if (ownerFence.count !== 1) return 'retry';
    const claimFence = await client.webhookExecutionClaim.updateMany({
      where: {
        id: claim.id,
        webhookEventId: owner.id,
        kind: 'EXECUTION',
        semanticKey,
        enforced: true,
        status: 'READY',
        preparedAt: claim.preparedAt,
        leaseToken: claim.leaseToken,
        leaseExpiresAt: claim.leaseExpiresAt,
      },
      data: { enforced: true },
    });
    if (claimFence.count !== 1) return 'retry';
    const settled = await client.webhookEvent.updateMany({
      where: {
        ...mirrorWhere,
        normalizedPayload: { equals: mirror.normalizedPayload as Prisma.InputJsonValue },
      },
      data: {
        status: WebhookStatus.DUPLICATE,
        processedAt: new Date(),
        queueName: null,
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
        errorMessage: null,
      },
    });
    if (settled.count !== 1)
      throw new WebhookTimeoutSettlementCasLostError(`Mirror settlement CAS lost for ${mirror.id}`);
    return 'settled';
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
      semanticClaim.webhookEventId === context.webhookEvent.id ||
      typeof semanticClaim.enforced !== 'boolean'
    ) {
      return 'invalid';
    }

    if (semanticClaim.status === 'PENDING' || semanticClaim.status === 'READY') return 'retry';
    if (
      semanticClaim.status !== 'COMPLETED' ||
      !(semanticClaim.preparedAt instanceof Date) ||
      !Number.isFinite(semanticClaim.preparedAt.getTime()) ||
      !(semanticClaim.completedAt instanceof Date) ||
      !Number.isFinite(semanticClaim.completedAt.getTime()) ||
      semanticClaim.leaseToken !== null ||
      semanticClaim.leaseExpiresAt !== null
    )
      return 'invalid';
    if (semanticClaim.webhookEventId === null) {
      // FLAG: A completed enforced EXECUTION row survives body retention as a semantic
      // tombstone. It may only settle a validated mirror; absent/leased/nonterminal proof
      // never becomes a new receipt owner or a fresh business execution.
      if (semanticClaim.enforced !== true || hasWebhookReplayFence(mirrorEvent)) return 'invalid';
      const fence = await executionClaimModel.updateMany({
        where: {
          id: semanticClaim.id,
          kind: 'EXECUTION',
          semanticKey,
          webhookEventId: null,
          enforced: true,
          status: 'COMPLETED',
          preparedAt: semanticClaim.preparedAt,
          completedAt: semanticClaim.completedAt,
          leaseToken: null,
          leaseExpiresAt: null,
        },
        data: { enforced: true },
      });
      if (fence.count !== 1) return 'retry';
      const settled = await client.webhookEvent.updateMany({
        where: {
          ...mirrorWhere,
          normalizedPayload: { equals: mirrorEvent.normalizedPayload as Prisma.InputJsonValue },
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
      if (settled.count !== 1)
        throw new WebhookTimeoutSettlementCasLostError(
          `Tombstone mirror CAS lost for ${mirrorEvent.id}`,
        );
      return 'settled';
    }
    if (!semanticClaim.webhookEventId) return 'invalid';
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
      return ownerEvent.status === WebhookStatus.DUPLICATE ||
        ownerEvent.status === WebhookStatus.NO_REPLAY_HELD
        ? 'invalid'
        : 'retry';
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
        businessStartedAt: null,
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

    let orderAnchor = { id: webhookEvent.id, createdAt: webhookEvent.createdAt };
    const semanticKey = buildWebhookSemanticEventKey(update);
    if (semanticKey && typeof this.prisma.webhookEvent.findFirst === 'function') {
      // FLAG: The earliest receipt is the logical order anchor even when another bot won
      // preparation. Its pending mirror remains the chat head until this owner completes.
      const anchor = await this.prisma.webhookEvent.findFirst({
        where: { semanticKey },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          createdAt: true,
          status: true,
          normalizedPayload: true,
          errorMessage: true,
          timeoutQuarantineExpiresAt: true,
        },
      });
      if (
        !anchor ||
        buildWebhookSemanticEventKey(anchor.normalizedPayload) !== semanticKey ||
        hasWebhookReplayFence(anchor)
      )
        throw new WebhookPreparationDeferredError('Semantic order anchor proof pending', 1_000);
      const priorExecution = await this.prisma.webhookEvent.findFirst({
        where: {
          semanticKey,
          id: { not: webhookEvent.id },
          OR: [
            { status: WebhookStatus.PROCESSED },
            { timeoutQuarantineExpiresAt: { not: null } },
            { errorMessage: { contains: 'AMBIGUOUS', mode: 'insensitive' } },
            { errorMessage: { startsWith: WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX } },
            { errorMessage: { startsWith: 'WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINED' } },
          ],
        },
        select: { id: true },
      });
      if (priorExecution)
        throw new WebhookPreparationDeferredError(
          'Legacy mirror retains business execution proof',
          1_000,
        );
      orderAnchor = anchor;
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
        AND NOT ${legacyOrderReleasedSql('webhook_events')}
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
          "created_at" < ${orderAnchor.createdAt}
          OR ("created_at" = ${orderAnchor.createdAt} AND "id" < ${orderAnchor.id})
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
          options?: { maxWait?: number; timeout?: number },
        ) => Promise<R>;
      }
    ).$transaction;
    if (typeof transaction !== 'function') {
      return operation(this.prisma as unknown as WebhookCanonicalPersistenceClient);
    }
    return transaction.call(this.prisma, operation, {
      maxWait: WEBHOOK_TIMEOUT_PERSISTENCE_TRANSACTION_MAX_WAIT_MS,
      timeout: WEBHOOK_TIMEOUT_PERSISTENCE_TRANSACTION_TIMEOUT_MS,
    }) as Promise<T>;
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
