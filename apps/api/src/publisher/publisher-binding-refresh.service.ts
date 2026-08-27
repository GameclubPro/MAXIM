import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { buildBotAccessSnapshotPersistence } from '../max/bot-access-snapshot.util';
import { MaxClientService } from '../max/max-client.service';
import { ChatBotAccessState, ChatBotMembershipStatus, Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherActionCredentialService } from './publisher-action-credential.service';
import { PublisherBackgroundWorkCoordinatorService } from './publisher-background-work-coordinator.service';
import { PublisherIdentityAttestationService } from './publisher-identity-attestation.service';
import {
  hasPublisherRefreshEvidence,
  publisherRefreshEvidenceWhere,
} from './publisher-entity-connection.util';
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
const PUBLISHER_REFRESH_SCAN_INTERVAL_MS = 60_000;
const PUBLISHER_READY_REFRESH_BATCH_SIZE = 200;
const PUBLISHER_DISCOVERY_REFRESH_BATCH_SIZE = 25;
const PUBLISHER_ACCESS_REFRESH_AHEAD_MS = 2 * 60_000;
const PUBLISHER_UNKNOWN_REPROBE_COOLDOWN_MS = 5 * 60_000;
const PUBLISHER_NON_ADMIN_REPROBE_COOLDOWN_MS = 15 * 60_000;
const PUBLISHER_LOST_REPROBE_COOLDOWN_MS = 6 * 60 * 60_000;

type PublisherBindingRefreshCandidate = { chatId: string };

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
        publisherBinding: true,
      },
    });
    // FLAG: Queued refresh jobs may verify an evidenced binding, never establish one.
    if (
      !candidate ||
      candidate.publicationPolicy?.publikEnabled === false ||
      candidate.botMemberships.length === 0 ||
      !hasPublisherRefreshEvidence(candidate.publisherBinding, this.publisherBotId)
    ) {
      return;
    }

    const probeStartedAt = new Date();
    try {
      const access = await this.maxClient.getCurrentChatMemberAccess(chatId, {
        botId: this.publisherBotId,
        trafficClass: job.reason === 'manual_recheck' ? 'interactive' : 'background',
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
export class PublisherBindingRefreshSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublisherBindingRefreshSchedulerService.name);
  private readonly publisherBotId: string;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private discoveryCursor: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
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
    }, PUBLISHER_REFRESH_SCAN_INTERVAL_MS);
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
      await this.backgroundWork.runExclusive('binding_refresh', async () => {
        if (await this.dispatchHealth.isGloballyPaused()) {
          return;
        }
        await this.identityAttestation.assertAttested();
        const now = new Date();
        // FLAG: Publisher webhooks own binding creation; this scan only refreshes existing evidence.
        const readyBindings = await this.readReadyRefreshCandidates(now);
        const discoveryBindings = await this.readDiscoveryRefreshCandidates(now);

        for (const binding of [...readyBindings, ...discoveryBindings]) {
          await this.refreshQueue.enqueue({
            chatId: binding.chatId,
            publisherBotId: this.publisherBotId,
            reason: 'stale_access',
            requestedAt: now,
          });
        }

        this.discoveryCursor =
          discoveryBindings.length < PUBLISHER_DISCOVERY_REFRESH_BATCH_SIZE
            ? null
            : (discoveryBindings.at(-1)?.chatId ?? null);
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          reason,
          err: error instanceof Error ? error.message : String(error),
        },
        'Publisher binding refresh scan failed',
      );
    } finally {
      this.inFlight = false;
    }
  }

  private readReadyRefreshCandidates(now: Date): Promise<PublisherBindingRefreshCandidate[]> {
    const refreshBefore = new Date(now.getTime() + PUBLISHER_ACCESS_REFRESH_AHEAD_MS);
    return this.prisma.publisherEntityBinding.findMany({
      where: {
        publisherBotId: this.publisherBotId,
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: {
          in: [ChatBotAccessState.CONFIRMED_ADMIN, ChatBotAccessState.CONFIRMED_OWNER],
        },
        chat: this.managedChatFilter(),
        OR: [{ botAccessExpiresAt: null }, { botAccessExpiresAt: { lte: refreshBefore } }],
      },
      select: { chatId: true },
      orderBy: [{ botAccessExpiresAt: { sort: 'asc', nulls: 'first' } }, { chatId: 'asc' }],
      take: PUBLISHER_READY_REFRESH_BATCH_SIZE,
    });
  }

  private readDiscoveryRefreshCandidates(now: Date): Promise<PublisherBindingRefreshCandidate[]> {
    const unknownRetryBefore = new Date(now.getTime() - PUBLISHER_UNKNOWN_REPROBE_COOLDOWN_MS);
    const nonAdminRetryBefore = new Date(now.getTime() - PUBLISHER_NON_ADMIN_REPROBE_COOLDOWN_MS);
    const lostRetryBefore = new Date(now.getTime() - PUBLISHER_LOST_REPROBE_COOLDOWN_MS);
    const refreshBefore = new Date(now.getTime() + PUBLISHER_ACCESS_REFRESH_AHEAD_MS);
    return this.prisma.publisherEntityBinding.findMany({
      where: {
        ...publisherRefreshEvidenceWhere(this.publisherBotId),
        ...(this.discoveryCursor ? { chatId: { gt: this.discoveryCursor } } : {}),
        chat: this.managedChatFilter(),
        AND: [
          {
            OR: [
              {
                botAccessState: ChatBotAccessState.UNKNOWN,
                OR: [
                  { botAccessCheckedAt: { lte: unknownRetryBefore } },
                  {
                    botAccessCheckedAt: null,
                    updatedAt: { lte: unknownRetryBefore },
                  },
                ],
              },
              {
                botAccessState: {
                  in: [ChatBotAccessState.CONFIRMED_MEMBER, ChatBotAccessState.STALE],
                },
                OR: [
                  { botAccessExpiresAt: { lte: refreshBefore } },
                  {
                    botAccessExpiresAt: null,
                    botAccessCheckedAt: { lte: nonAdminRetryBefore },
                  },
                  {
                    botAccessExpiresAt: null,
                    botAccessCheckedAt: null,
                    updatedAt: { lte: nonAdminRetryBefore },
                  },
                ],
              },
              {
                botAccessState: { in: [ChatBotAccessState.DENIED, ChatBotAccessState.LOST] },
                OR: [
                  { botAccessCheckedAt: { lte: lostRetryBefore } },
                  {
                    botAccessCheckedAt: null,
                    updatedAt: { lte: unknownRetryBefore },
                  },
                ],
              },
            ],
          },
        ],
      },
      select: { chatId: true },
      orderBy: { chatId: 'asc' },
      take: PUBLISHER_DISCOVERY_REFRESH_BATCH_SIZE,
    });
  }

  private managedChatFilter() {
    return {
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
    } satisfies Prisma.ChatWhereInput;
  }
}
