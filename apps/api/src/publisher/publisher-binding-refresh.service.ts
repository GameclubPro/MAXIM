import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { buildBotAccessSnapshotPersistence } from '../max/bot-access-snapshot.util';
import { MaxClientService } from '../max/max-client.service';
import { ChatBotAccessState, ChatBotMembershipStatus, Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherActionCredentialService } from './publisher-action-credential.service';
import { PublisherBackgroundWorkCoordinatorService } from './publisher-background-work-coordinator.service';
import { PublisherIdentityAttestationService } from './publisher-identity-attestation.service';
import { PublisherRuntimeBoundaryService } from './publisher-runtime-boundary.service';
import {
  type PublisherBindingRefreshJob,
  PublisherBindingRefreshQueueService,
} from './publisher-binding-refresh.queue';
import {
  classifyPublisherFailure,
  extractPublisherMaxStatusCode,
  PublisherDispatchHealthService,
} from './publisher-dispatch-health.service';

const PUBLISHER_ACCESS_SNAPSHOT_TTL_MS = 15 * 60_000;
const PUBLISHER_BOOTSTRAP_SCAN_INTERVAL_MS = 60_000;
const PUBLISHER_BOOTSTRAP_SCAN_BATCH_SIZE = 100;
const PUBLISHER_STALE_REFRESH_BATCH_SIZE = 100;
const PUBLISHER_ACCESS_REFRESH_AHEAD_MS = 2 * 60_000;

type PublisherBootstrapCandidate = { id: string };

@Injectable()
export class PublisherBindingRefreshService {
  private readonly logger = new Logger(PublisherBindingRefreshService.name);
  private readonly publisherBotId: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly credentials: PublisherActionCredentialService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
    private readonly identityAttestation: PublisherIdentityAttestationService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
  ) {
    this.publisherBotId = credentials.getBotId();
    credentials.getRequiredActionToken(this.publisherBotId);
  }

  async refresh(job: PublisherBindingRefreshJob): Promise<void> {
    if (!this.runtimeBoundary.dispatchEnabled) {
      return;
    }
    if (job.version !== 1 || job.publisherBotId.trim() !== this.publisherBotId) {
      throw new Error('Publisher binding refresh job targets a different bot');
    }
    const chatId = job.chatId.trim();
    if (!chatId) {
      return;
    }
    await this.identityAttestation.assertAttested();
    if (await this.dispatchHealth.isGloballyPaused()) {
      return;
    }

    const candidate = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        id: true,
        publicationPolicy: {
          select: { publikEnabled: true },
        },
        botMemberships: {
          where: {
            status: ChatBotMembershipStatus.ACTIVE,
            botId: { not: this.publisherBotId },
          },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (
      !candidate ||
      candidate.publicationPolicy?.publikEnabled === false ||
      candidate.botMemberships.length === 0
    ) {
      return;
    }

    await this.ensureBinding(chatId);
    const probeStartedAt = new Date();
    try {
      const access = await this.maxClient.getCurrentChatMemberAccess(chatId, {
        botId: this.publisherBotId,
        trafficClass: 'background',
        sourceTag: 'publisher_readiness',
        bypassCache: true,
        timeoutMs: 5_000,
      });
      const checkedAt = new Date();
      const snapshot = buildBotAccessSnapshotPersistence(access, {
        source: `publisher_refresh_${job.reason}`,
        now: checkedAt,
        ttlMs: PUBLISHER_ACCESS_SNAPSHOT_TTL_MS,
      });
      const committed = await this.prisma.publisherEntityBinding.updateMany({
        where: {
          chatId,
          publisherBotId: this.publisherBotId,
          AND: [
            {
              OR: [{ lifecycleEventAt: null }, { lifecycleEventAt: { lte: probeStartedAt } }],
            },
            {
              OR: [{ botAccessCheckedAt: null }, { botAccessCheckedAt: { lte: probeStartedAt } }],
            },
          ],
        },
        data: {
          status: ChatBotMembershipStatus.ACTIVE,
          capabilities: access.permissions,
          ...snapshot,
          lastSeenAt: checkedAt,
        },
      });
      if (committed.count === 0) {
        this.logger.debug(
          { chatId, reason: job.reason },
          'Discarded publisher access probe superseded by a newer lifecycle event',
        );
        return;
      }
      await this.dispatchHealth.recordAuthenticatedSuccess(probeStartedAt);
    } catch (error: unknown) {
      const classification = classifyPublisherFailure(error);
      if (classification === 'global_paused') {
        await this.dispatchHealth.recordGlobalAuthorizationFailure(new Date());
        throw error;
      }
      if (classification === 'setup_required') {
        await this.recordAccessLost(chatId, probeStartedAt, error);
        return;
      }
      throw error;
    }
  }

  async ensureBinding(chatId: string): Promise<void> {
    await this.prisma.publisherEntityBinding.createMany({
      data: [
        {
          chatId,
          publisherBotId: this.publisherBotId,
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState: ChatBotAccessState.UNKNOWN,
          botAccessSource: 'publisher_bootstrap_candidate',
        },
      ],
      skipDuplicates: true,
    });
  }

  private async recordAccessLost(
    chatId: string,
    probeStartedAt: Date,
    error: unknown,
  ): Promise<void> {
    const statusCode = extractPublisherMaxStatusCode(error);
    const checkedAt = new Date();
    await this.prisma.publisherEntityBinding.updateMany({
      where: {
        chatId,
        publisherBotId: this.publisherBotId,
        AND: [
          {
            OR: [{ lifecycleEventAt: null }, { lifecycleEventAt: { lte: probeStartedAt } }],
          },
          {
            OR: [{ botAccessCheckedAt: null }, { botAccessCheckedAt: { lte: probeStartedAt } }],
          },
        ],
      },
      data: {
        permissionsSnapshot: Prisma.JsonNull,
        botAccessState: ChatBotAccessState.LOST,
        botAccessCheckedAt: checkedAt,
        botAccessExpiresAt: null,
        botAccessSource: 'publisher_targeted_access_probe',
        botAccessLastErrorCode: statusCode ? `HTTP_${statusCode}` : 'ACCESS_LOST',
        permissionsHash: null,
      },
    });
  }
}

@Injectable()
export class PublisherBindingBootstrapSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublisherBindingBootstrapSchedulerService.name);
  private readonly publisherBotId: string;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private cursor: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly refreshService: PublisherBindingRefreshService,
    private readonly refreshQueue: PublisherBindingRefreshQueueService,
    credentials: PublisherActionCredentialService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
    private readonly identityAttestation: PublisherIdentityAttestationService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
    private readonly backgroundWork: PublisherBackgroundWorkCoordinatorService,
  ) {
    this.publisherBotId = credentials.getBotId();
    // FLAG: Resolve before scanning so this worker can never probe with another bot token.
    credentials.getRequiredActionToken(this.publisherBotId);
  }

  onModuleInit(): void {
    if (!this.runtimeBoundary.dispatchEnabled) {
      return;
    }
    this.timer = setInterval(() => {
      void this.scan('scheduled');
    }, PUBLISHER_BOOTSTRAP_SCAN_INTERVAL_MS);
    this.timer.unref();
    void this.scan('startup');
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async scan(reason: 'startup' | 'scheduled'): Promise<void> {
    if (!this.runtimeBoundary.dispatchEnabled || this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      await this.backgroundWork.runExclusive('binding_bootstrap', async () => {
        if (await this.dispatchHealth.isGloballyPaused()) {
          return;
        }
        await this.identityAttestation.assertAttested();
        const now = new Date();
        const bootstrapCandidates = await this.readBootstrapCandidates();
        const staleBindings = await this.prisma.publisherEntityBinding.findMany({
          where: {
            publisherBotId: this.publisherBotId,
            status: ChatBotMembershipStatus.ACTIVE,
            chat: {
              botMemberships: {
                some: {
                  status: ChatBotMembershipStatus.ACTIVE,
                  botId: { not: this.publisherBotId },
                },
              },
              OR: [
                { publicationPolicy: { is: null } },
                { publicationPolicy: { is: { publikEnabled: true } } },
              ],
            },
            OR: [
              { botAccessCheckedAt: null },
              { botAccessExpiresAt: null },
              {
                botAccessExpiresAt: {
                  lte: new Date(now.getTime() + PUBLISHER_ACCESS_REFRESH_AHEAD_MS),
                },
              },
            ],
          },
          select: { chatId: true },
          orderBy: { chatId: 'asc' },
          take: PUBLISHER_STALE_REFRESH_BATCH_SIZE,
        });

        for (const candidate of bootstrapCandidates) {
          await this.refreshService.ensureBinding(candidate.id);
          await this.refreshQueue.enqueue({
            chatId: candidate.id,
            publisherBotId: this.publisherBotId,
            reason: 'bootstrap',
            requestedAt: now,
          });
        }
        for (const binding of staleBindings) {
          await this.refreshQueue.enqueue({
            chatId: binding.chatId,
            publisherBotId: this.publisherBotId,
            reason: 'stale_access',
            requestedAt: now,
          });
        }

        this.cursor =
          bootstrapCandidates.length < PUBLISHER_BOOTSTRAP_SCAN_BATCH_SIZE
            ? null
            : (bootstrapCandidates.at(-1)?.id ?? null);
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          reason,
          err: error instanceof Error ? error.message : String(error),
        },
        'Publisher binding bootstrap scan failed',
      );
    } finally {
      this.inFlight = false;
    }
  }

  private readBootstrapCandidates(): Promise<PublisherBootstrapCandidate[]> {
    const removedRefreshBefore = new Date(Date.now() - 30 * 60_000);
    return this.prisma.$queryRaw<PublisherBootstrapCandidate[]>(Prisma.sql`
      SELECT chat."id"
      FROM "chats" AS chat
      LEFT JOIN "managed_entity_publication_policies" AS policy
        ON policy."chat_id" = chat."id"
      LEFT JOIN "publisher_entity_bindings" AS binding
        ON binding."chat_id" = chat."id"
       AND binding."publisher_bot_id" = ${this.publisherBotId}
      WHERE (${this.cursor}::text IS NULL OR chat."id" > ${this.cursor})
        AND COALESCE(policy."publik_enabled", TRUE) = TRUE
        AND (
          binding."chat_id" IS NULL
          OR (
            binding."status" = 'REMOVED'
            AND (
              binding."bot_access_checked_at" IS NULL
              OR binding."bot_access_checked_at" <= ${removedRefreshBefore}
            )
          )
        )
        AND EXISTS (
          SELECT 1
          FROM "chat_bot_memberships" AS membership
          WHERE membership."chat_id" = chat."id"
            AND membership."status" = 'ACTIVE'
            AND membership."bot_id" <> ${this.publisherBotId}
        )
      ORDER BY chat."id" ASC
      LIMIT ${PUBLISHER_BOOTSTRAP_SCAN_BATCH_SIZE}
    `);
  }
}
