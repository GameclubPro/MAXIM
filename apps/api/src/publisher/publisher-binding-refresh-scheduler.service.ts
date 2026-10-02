import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ManagedEntityAccessRole,
  ManagedEntityAccessState,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherActionCredentialService } from './publisher-action-credential.service';
import { PublisherBackgroundWorkCoordinatorService } from './publisher-background-work-coordinator.service';
import { PublisherIdentityAttestationService } from './publisher-identity-attestation.service';
import { publisherRefreshEvidenceWhere } from './publisher-entity-connection.util';
import { PublisherRuntimeBoundaryService } from './publisher-runtime-boundary.service';
import {
  PUBLISHER_ACCESS_CANDIDATE_SOURCE,
  PUBLISHER_ACCESS_CANDIDATE_PENDING_REASON,
  PublisherEntityBindingLifecycleService,
} from './publisher-entity-binding-lifecycle.service';
import { PublisherBindingRefreshQueueService } from './publisher-binding-refresh.queue';
import { PublisherDispatchHealthService } from './publisher-dispatch-health.service';
import { PublisherAccessRefreshPolicy } from './publisher-access-refresh-policy';

const PUBLISHER_FORWARDED_CANDIDATE_SOURCE = `${PUBLISHER_ACCESS_CANDIDATE_SOURCE}_forwarded`;
const PUBLISHER_REFRESH_SCAN_INTERVAL_MS = 60_000;
const PUBLISHER_READY_REFRESH_BATCH_SIZE = 200;
const PUBLISHER_DISCOVERY_REFRESH_BATCH_SIZE = 25;
const PUBLISHER_BINDING_ACCESS_REFRESH_AHEAD_MS = 5 * 60_000;
// At 25 actor edges per minute, the scheduler can nominate 18k unique edges in this window.
const PUBLISHER_USER_ACCESS_REFRESH_AHEAD_MS = 12 * 60 * 60_000;
const PUBLISHER_UNKNOWN_REPROBE_COOLDOWN_MS = 5 * 60_000;
const PUBLISHER_NON_ADMIN_REPROBE_COOLDOWN_MS = 15 * 60_000;
const PUBLISHER_LOST_REPROBE_COOLDOWN_MS = 6 * 60 * 60_000;
const PUBLISHER_USER_ACCESS_REFRESH_BATCH_SIZE = 25;
const PUBLISHER_PENDING_CANDIDATE_RETRY_MS = 60_000;
const PUBLISHER_DENIED_USER_ACCESS_REPROBE_COOLDOWN_MS = 6 * 60 * 60_000;
const PUBLISHER_ACTOR_EVIDENCE_LOOKBACK_MS = 30 * 24 * 60 * 60_000;
type PublisherBindingRefreshCandidate = { chatId: string; botAccessExpiresAt?: Date | null };
type PublisherUserAccessRefreshCandidate = {
  chatId: string;
  userId: string;
  sourceVersion: string | null;
};
type PublisherUserAccessRefreshCursor = { chatId: string; userId: string };

@Injectable()
export class PublisherBindingRefreshSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublisherBindingRefreshSchedulerService.name);
  private readonly publisherBotId: string;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private readyBindingCursor: string | null = null;
  private expiryCursor: { chatId: string; botAccessExpiresAt: Date } | null = null;
  private nullExpiryCursor: string | null = null;
  private rosterInitCursor: string | null = null;
  private rosterDueCursor: { chatId: string; rosterRefreshAfter: Date } | null = null;
  private discoveryCursor: string | null = null;
  private userAccessCursor: PublisherUserAccessRefreshCursor | null = null;
  private lastBacklogCompactionAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly refreshQueue: PublisherBindingRefreshQueueService,
    credentials: PublisherActionCredentialService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
    private readonly identityAttestation: PublisherIdentityAttestationService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
    private readonly backgroundWork: PublisherBackgroundWorkCoordinatorService,
    private readonly bindingLifecycle: PublisherEntityBindingLifecycleService,
    @Optional()
    private readonly policy: PublisherAccessRefreshPolicy = new PublisherAccessRefreshPolicy(),
  ) {
    this.publisherBotId = credentials.getBotId();
    // FLAG: Resolve before scanning so this worker can never probe with another bot token.
    credentials.getRequiredActionToken(this.publisherBotId);
  }

  async onModuleInit(): Promise<void> {
    if (!this.runtimeBoundary.dispatchEnabled) {
      return;
    }
    this.timer = setInterval(() => {
      void this.scan('scheduled');
    }, PUBLISHER_REFRESH_SCAN_INTERVAL_MS);
    this.timer.unref();
    this.inFlight = true;
    try {
      const compacted = await this.refreshQueue.compactScheduledBacklog();
      this.lastBacklogCompactionAt = Date.now();
      if (compacted.scheduledCount > 0 || compacted.truncated) {
        this.logger.log({ ...compacted }, 'Compacted Publisher scheduled refresh backlog');
      }
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Publisher scheduled refresh backlog compaction failed',
      );
    } finally {
      this.inFlight = false;
    }
    await this.scan('startup');
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
      if (
        reason === 'scheduled' &&
        Date.now() - this.lastBacklogCompactionAt >= PUBLISHER_REFRESH_SCAN_INTERVAL_MS &&
        this.refreshQueue.compactScheduledBacklog
      ) {
        await this.refreshQueue.compactScheduledBacklog();
        this.lastBacklogCompactionAt = Date.now();
      }
      await this.backgroundWork.runExclusive('binding_refresh', async () => {
        if (await this.dispatchHealth.isGloballyPaused()) {
          return;
        }
        await this.identityAttestation.assertAttested();
        const now = new Date();
        // FLAG: Publisher webhooks own binding creation; this scan only refreshes existing evidence.
        await this.bindingLifecycle.recoverHistoricalActorCandidates(now);
        const readyBindings = await this.readReadyRefreshCandidates(now);
        const discoveryBindings = await this.readDiscoveryRefreshCandidates(now);
        const userAccessBindings = await this.readUserAccessRefreshCandidates(now);

        const readyById = new Map(readyBindings.map((binding) => [binding.chatId, binding]));
        const readyIds = new Set(readyById.keys());
        const bindingIds = new Set([
          ...readyIds,
          ...discoveryBindings.map((binding) => binding.chatId),
        ]);
        for (const chatId of bindingIds) {
          await this.refreshQueue.enqueue({
            chatId,
            publisherBotId: this.publisherBotId,
            reason: readyIds.has(chatId) ? 'scheduled_bot_access' : 'stale_access',
            requestedAt: now,
            ...(this.policy.deadlinePrioritiesEnabled && readyIds.has(chatId)
              ? {
                  requiredBefore: readyById.get(chatId)?.botAccessExpiresAt ?? now,
                }
              : {}),
          });
        }
        if (this.policy.deadlinePrioritiesEnabled) await this.scheduleRoster(now);
        for (const binding of userAccessBindings) {
          await this.refreshQueue.enqueue({
            chatId: binding.chatId,
            publisherBotId: this.publisherBotId,
            candidateUserId: binding.userId,
            ...(binding.sourceVersion ? { candidateVersion: binding.sourceVersion } : {}),
            reason: 'stale_user_access',
            requestedAt: now,
          });
        }
        if (this.policy.deadlinePrioritiesEnabled)
          this.logger.log(
            {
              metric: 'publisher_access_scan_v1',
              mode: this.policy.mode,
              readyRows: readyBindings.length,
              discoveryRows: discoveryBindings.length,
              actorRows: userAccessBindings.length,
              expiryCycleComplete: this.expiryCursor === null,
              missingExpiryCycleComplete: this.nullExpiryCursor === null,
              rosterInitCycleComplete: this.rosterInitCursor === null,
              rosterDueCycleComplete: this.rosterDueCursor === null,
            },
            'Publisher access schedule scan',
          );
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

  private async readReadyRefreshCandidates(now: Date): Promise<PublisherBindingRefreshCandidate[]> {
    if (this.policy.deadlinePrioritiesEnabled) return this.readDeadlineCandidates(now);
    const refreshBefore = new Date(now.getTime() + PUBLISHER_BINDING_ACCESS_REFRESH_AHEAD_MS);
    const rows = await this.prisma.publisherEntityBinding.findMany({
      where: {
        publisherBotId: this.publisherBotId,
        status: ChatBotMembershipStatus.ACTIVE,
        ...(this.readyBindingCursor ? { chatId: { gt: this.readyBindingCursor } } : {}),
        botAccessState: {
          in: [ChatBotAccessState.CONFIRMED_ADMIN, ChatBotAccessState.CONFIRMED_OWNER],
        },
        OR: [{ botAccessExpiresAt: null }, { botAccessExpiresAt: { lte: refreshBefore } }],
      },
      select: { chatId: true },
      orderBy: { chatId: 'asc' },
      take: PUBLISHER_READY_REFRESH_BATCH_SIZE,
    });
    this.readyBindingCursor =
      rows.length < PUBLISHER_READY_REFRESH_BATCH_SIZE ? null : (rows.at(-1)?.chatId ?? null);
    return rows;
  }

  private async readDeadlineCandidates(now: Date): Promise<PublisherBindingRefreshCandidate[]> {
    const scope = {
      publisherBotId: this.publisherBotId,
      status: ChatBotMembershipStatus.ACTIVE,
      botAccessState: {
        in: [ChatBotAccessState.CONFIRMED_ADMIN, ChatBotAccessState.CONFIRMED_OWNER],
      },
    };
    // FLAG: Null deadlines have their own bounded lane so corrupt/missing proofs cannot
    // monopolize expiring evidence. Tuple cursors advance past slow or retrying head rows.
    const nullRows = await this.prisma.publisherEntityBinding.findMany({
      where: {
        ...scope,
        botAccessExpiresAt: null,
        ...(this.nullExpiryCursor ? { chatId: { gt: this.nullExpiryCursor } } : {}),
      },
      select: { chatId: true, botAccessExpiresAt: true },
      orderBy: { chatId: 'asc' },
      take: 25,
    });
    this.nullExpiryCursor = nullRows.length < 25 ? null : nullRows.at(-1)!.chatId;
    const rows = await this.prisma.publisherEntityBinding.findMany({
      where: {
        ...scope,
        botAccessExpiresAt: {
          lte: new Date(now.getTime() + PUBLISHER_BINDING_ACCESS_REFRESH_AHEAD_MS),
        },
        ...(this.expiryCursor
          ? {
              OR: [
                { botAccessExpiresAt: { gt: this.expiryCursor.botAccessExpiresAt } },
                {
                  botAccessExpiresAt: this.expiryCursor.botAccessExpiresAt,
                  chatId: { gt: this.expiryCursor.chatId },
                },
              ],
            }
          : {}),
      },
      select: { chatId: true, botAccessExpiresAt: true },
      orderBy: [{ botAccessExpiresAt: 'asc' }, { chatId: 'asc' }],
      take: PUBLISHER_READY_REFRESH_BATCH_SIZE,
    });
    const last = rows.at(-1);
    this.expiryCursor =
      rows.length < PUBLISHER_READY_REFRESH_BATCH_SIZE || !last?.botAccessExpiresAt
        ? null
        : { chatId: last.chatId, botAccessExpiresAt: last.botAccessExpiresAt };
    return [...nullRows, ...rows];
  }

  private async scheduleRoster(now: Date): Promise<void> {
    const scope = { publisherBotId: this.publisherBotId, status: ChatBotMembershipStatus.ACTIVE };
    const initial = await this.prisma.publisherEntityBinding.findMany({
      where: {
        ...scope,
        rosterRefreshAfter: null,
        ...(this.rosterInitCursor ? { chatId: { gt: this.rosterInitCursor } } : {}),
      },
      select: { chatId: true },
      orderBy: { chatId: 'asc' },
      take: 200,
    });
    this.rosterInitCursor = initial.length < 200 ? null : initial.at(-1)!.chatId;
    for (const binding of initial) {
      if (!this.policy.separatesMaintenance(this.publisherBotId, binding.chatId)) continue;
      await this.prisma.publisherEntityBinding.updateMany({
        where: { ...scope, chatId: binding.chatId, rosterRefreshAfter: null },
        data: {
          rosterRefreshAfter: this.policy.initialRosterRefreshAt(
            this.publisherBotId,
            binding.chatId,
            now,
          ),
        },
      });
    }
    const due = await this.prisma.publisherEntityBinding.findMany({
      where: {
        ...scope,
        rosterRefreshAfter: { lte: now },
        botAccessState: {
          in: [ChatBotAccessState.CONFIRMED_ADMIN, ChatBotAccessState.CONFIRMED_OWNER],
        },
        ...(this.rosterDueCursor
          ? {
              OR: [
                { rosterRefreshAfter: { gt: this.rosterDueCursor.rosterRefreshAfter } },
                {
                  rosterRefreshAfter: this.rosterDueCursor.rosterRefreshAfter,
                  chatId: { gt: this.rosterDueCursor.chatId },
                },
              ],
            }
          : {}),
      },
      select: { chatId: true, rosterRefreshAfter: true },
      orderBy: [{ rosterRefreshAfter: 'asc' }, { chatId: 'asc' }],
      take: 25,
    });
    const last = due.at(-1);
    this.rosterDueCursor =
      due.length < 25 || !last?.rosterRefreshAfter
        ? null
        : { chatId: last.chatId, rosterRefreshAfter: last.rosterRefreshAfter };
    for (const binding of due) {
      if (!this.policy.separatesMaintenance(this.publisherBotId, binding.chatId)) continue;
      await this.refreshQueue.enqueue({
        chatId: binding.chatId,
        publisherBotId: this.publisherBotId,
        reason: 'binding_maintenance',
        requestedAt: now,
      });
    }
  }

  private async readDiscoveryRefreshCandidates(
    now: Date,
  ): Promise<PublisherBindingRefreshCandidate[]> {
    const unknownRetryBefore = new Date(now.getTime() - PUBLISHER_UNKNOWN_REPROBE_COOLDOWN_MS);
    const nonAdminRetryBefore = new Date(now.getTime() - PUBLISHER_NON_ADMIN_REPROBE_COOLDOWN_MS);
    const lostRetryBefore = new Date(now.getTime() - PUBLISHER_LOST_REPROBE_COOLDOWN_MS);
    const refreshBefore = new Date(now.getTime() + PUBLISHER_BINDING_ACCESS_REFRESH_AHEAD_MS);
    const catalogRows = await this.prisma.managedBotChatCatalog.findMany({
      where: {
        botId: this.publisherBotId,
        status: 'ACTIVE',
        ...(this.discoveryCursor ? { chatId: { gt: this.discoveryCursor } } : {}),
      },
      select: { chatId: true },
      orderBy: { chatId: 'asc' },
      take: PUBLISHER_DISCOVERY_REFRESH_BATCH_SIZE,
    });
    this.discoveryCursor =
      catalogRows.length < PUBLISHER_DISCOVERY_REFRESH_BATCH_SIZE
        ? null
        : (catalogRows.at(-1)?.chatId ?? null);
    if (catalogRows.length === 0) {
      return [];
    }
    return this.prisma.publisherEntityBinding.findMany({
      where: {
        ...publisherRefreshEvidenceWhere(this.publisherBotId),
        chatId: { in: catalogRows.map((row) => row.chatId) },
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

  private async readUserAccessRefreshCandidates(
    now: Date,
  ): Promise<PublisherUserAccessRefreshCandidate[]> {
    const refreshBefore = new Date(now.getTime() + PUBLISHER_USER_ACCESS_REFRESH_AHEAD_MS);
    const pendingRetryBefore = new Date(now.getTime() - PUBLISHER_PENDING_CANDIDATE_RETRY_MS);
    const deniedRetryBefore = new Date(
      now.getTime() - PUBLISHER_DENIED_USER_ACCESS_REPROBE_COOLDOWN_MS,
    );
    const actorEvidenceAfter = new Date(now.getTime() - PUBLISHER_ACTOR_EVIDENCE_LOOKBACK_MS);
    const rows = await this.prisma.managedEntityAccessEdge.findMany({
      where: {
        botId: this.publisherBotId,
        OR: [
          {
            state: ManagedEntityAccessState.GRANTED,
            userRole: { in: [ManagedEntityAccessRole.OWNER, ManagedEntityAccessRole.ADMIN] },
            OR: [
              {
                source: { startsWith: `${PUBLISHER_ACCESS_CANDIDATE_SOURCE}_` },
                checkedAt: { lte: pendingRetryBefore },
                expiresAt: { gt: now },
              },
              { expiresAt: null },
              { expiresAt: { lte: refreshBefore } },
            ],
          },
          {
            state: {
              in: [ManagedEntityAccessState.USER_DENIED, ManagedEntityAccessState.BOT_DENIED],
            },
            OR: [
              {
                deniedReason: PUBLISHER_ACCESS_CANDIDATE_PENDING_REASON,
                checkedAt: { lte: pendingRetryBefore },
                expiresAt: { gt: now },
              },
              {
                createdAt: { gt: actorEvidenceAfter },
                checkedAt: { lte: deniedRetryBefore },
                OR: [{ expiresAt: null }, { expiresAt: { lte: now } }],
              },
            ],
          },
        ],
        AND: [
          {
            OR: [
              {
                chat: {
                  publisherBinding: { is: publisherRefreshEvidenceWhere(this.publisherBotId) },
                },
              },
              {
                source: PUBLISHER_FORWARDED_CANDIDATE_SOURCE,
                sourceVersion: { startsWith: 'forwarded:' },
              },
            ],
          },
          ...(this.userAccessCursor
            ? [
                {
                  OR: [
                    { chatId: { gt: this.userAccessCursor.chatId } },
                    {
                      chatId: this.userAccessCursor.chatId,
                      userId: { gt: this.userAccessCursor.userId },
                    },
                  ],
                },
              ]
            : []),
        ],
      },
      select: { chatId: true, userId: true, sourceVersion: true },
      orderBy: [{ chatId: 'asc' }, { userId: 'asc' }],
      take: PUBLISHER_USER_ACCESS_REFRESH_BATCH_SIZE,
    });
    this.userAccessCursor =
      rows.length < PUBLISHER_USER_ACCESS_REFRESH_BATCH_SIZE
        ? null
        : rows.at(-1)
          ? { chatId: rows.at(-1)!.chatId, userId: rows.at(-1)!.userId }
          : null;
    return rows;
  }
}
