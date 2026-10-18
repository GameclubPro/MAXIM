import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AdminManagedBroadcastRuntime } from '../../src/admin/admin-managed-broadcast-runtime';
import type { AdminManagedBroadcastRuntimeContext } from '../../src/admin/admin-managed-broadcast-runtime-context';
import { ManagedBroadcastService } from '../../src/admin/managed-broadcast.service';
import { ManagedEntitiesService } from '../../src/admin/managed-entities.service';
import { PublicationContentService } from '../../src/admin/publication-content.service';
import { PublicationPresenterService } from '../../src/admin/publication-presenter.service';
import { PublicationPublisherRoutingService } from '../../src/admin/publication-publisher-routing.service';
import { PublicationService } from '../../src/admin/publication.service';
import { PublisherDialogContextService } from '../../src/admin/publisher-dialog-context.service';
import { PublisherPolicyService } from '../../src/admin/publisher-policy.service';
import { PublisherPublicationWakeupQueueService } from '../../src/admin/publisher-publication-wakeup.queue';
import { MaxClientService, type MaxActionJob } from '../../src/max/max-client.service';
import { MaxRoutedPublicationService } from '../../src/max/max-routed-publication.service';
import { PublisherBindingRefreshQueueService } from '../../src/publisher/publisher-binding-refresh.queue';
import { PublisherDialogLinkService } from '../../src/publisher/publisher-dialog-link.service';
import { PublisherDialogSigningKeyService } from '../../src/publisher/publisher-dialog-signing-key.service';
import { PublisherDispatchHealthService } from '../../src/publisher/publisher-dispatch-health.service';
import { PublisherReadinessService } from '../../src/publisher/publisher-readiness.service';
import { PublisherRuntimeBoundaryService } from '../../src/publisher/publisher-runtime-boundary.service';
import { PublisherRuntimeHeartbeatReaderService } from '../../src/publisher/publisher-runtime-heartbeat.service';
import { getAppRole, roleRunsPublisher } from '../../src/runtime/app-role';
import { BackgroundRuntimeGovernorService } from '../../src/system/background-runtime-governor.service';
import { SystemModeService, type SystemModeSnapshot } from '../../src/system/system-mode.service';
import type { ProfileFixture } from './fixture';

export type ProfileTurn = 'now' | 'targeted' | 'deadline' | 'maintenance-run' | 'maintenance-pause';
export type ProfileRollupNoopMode = 'off' | '100';

export type ProfileRuntimeSnapshot = {
  sendCount: number;
  publishAttemptCount: number;
  presenceCount: number;
  refreshCount: number;
  wakeupCount: number;
  beforeSendRejectedCount: number;
  unexpectedBoundaryCount: number;
  targetSelectionCount: number;
  dispatchQuantumCount: number;
  warningCount: number;
  errorCount: number;
  sentTargetIds: readonly string[];
  presenceMessageIds: readonly string[];
  sentTargetIdsTruncated: boolean;
  presenceMessageIdsTruncated: boolean;
};

export type ProfileRuntime = {
  run(turn: ProfileTurn): Promise<void>;
  snapshot(): ProfileRuntimeSnapshot;
  close(): Promise<void>;
};

const SENT_TARGET_SAMPLE_LIMIT = 16;
const PRESENCE_SAMPLE_LIMIT = 64;

class ProfileLogger extends Logger {
  targetSelectionCount = 0;
  dispatchQuantumCount = 0;
  warningCount = 0;
  errorCount = 0;

  override log(message: unknown, ..._optionalParams: unknown[]): void {
    if (
      typeof message !== 'object' ||
      message === null ||
      !('metric' in message) ||
      message.metric !== 'publication_stage_v1' ||
      !('stage' in message)
    )
      return;
    if (message.stage === 'target_selection') this.targetSelectionCount += 1;
    if (message.stage === 'dispatch_quantum') this.dispatchQuantumCount += 1;
  }

  override warn(_message: unknown, ..._optionalParams: unknown[]): void {
    this.warningCount += 1;
  }

  override error(_message: unknown, ..._optionalParams: unknown[]): void {
    this.errorCount += 1;
  }
}

function healthySystemMode(): SystemModeSnapshot {
  return {
    mode: 'normal',
    source: 'auto',
    condition: 'healthy',
    reason: 'synthetic profile infrastructure',
    updatedAt: new Date().toISOString(),
    manualMode: null,
    queueLagSec: 0,
    action: {
      windowSec: 60,
      total: 0,
      success: 0,
      failure: 0,
      critical: 0,
      errorRate: 0,
      criticalRate: 0,
    },
  };
}

export async function createProfileRuntime(
  fixture: ProfileFixture,
  options: {
    beforeSendMutation?: () => Promise<void>;
    rollupNoopMode?: ProfileRollupNoopMode;
  } = {},
): Promise<ProfileRuntime> {
  if (!roleRunsPublisher(getAppRole())) {
    throw new Error('Publisher full-turn profile requires APP_ROLE=publisher');
  }
  let governorAction: 'run' | 'pause' = 'run';
  let sendCount = 0;
  let publishAttemptCount = 0;
  let presenceCount = 0;
  let refreshCount = 0;
  let wakeupCount = 0;
  let beforeSendRejectedCount = 0;
  let unexpectedBoundaryCount = 0;
  function unexpectedBoundary(name: string): Error {
    unexpectedBoundaryCount += 1;
    return new Error(`Publisher text profile unexpectedly called ${name}`);
  }
  // FLAG: Build membership outside timing; synthetic checks must not scan a 50k audience.
  const targetIds = new Set(fixture.chatIds);
  const receiptsByTarget = new Map<string, string>();
  const sentTargetIds: string[] = [];
  const presenceMessageIds: string[] = [];
  const logger = new ProfileLogger('PublisherTurnProfile');
  const config = new ConfigService({
    MAX_PUBLISHER_BOT_ID: fixture.botId,
    MAX_PUBLISHER_DISPATCH_ENABLED: true,
    PUBLISHER_TEMPORAL_SELECTION_ROLLOUT: 'off',
    PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT: options.rollupNoopMode ?? 'off',
  });

  const heartbeat = {
    read: async (botId: string) => {
      if (botId !== fixture.botId) throw unexpectedBoundary('foreign heartbeat');
      return {
        version: 1 as const,
        botId,
        dispatchEnabled: true,
        blocker: null,
        observedAt: new Date().toISOString(),
        instanceId: 'publisher-turn-profile',
      };
    },
  } satisfies Pick<PublisherRuntimeHeartbeatReaderService, 'read'>;
  const refreshQueue = {
    enqueue: async () => {
      refreshCount += 1;
      return `synthetic-refresh-${refreshCount}`;
    },
  } satisfies Pick<PublisherBindingRefreshQueueService, 'enqueue'>;
  const healthRedis = {
    status: 'ready',
    get: async () => null,
    eval: async () => 0,
    disconnect: () => undefined,
  } satisfies NonNullable<ConstructorParameters<typeof PublisherDispatchHealthService>[3]>;
  const boundary = {
    dispatchEnabled: true,
    assertDispatchEnabled: () => undefined,
  } satisfies Pick<PublisherRuntimeBoundaryService, 'dispatchEnabled' | 'assertDispatchEnabled'>;
  const governor = {
    decide: async () => ({ action: governorAction, retryAfterMs: 0, reason: 'profile scenario' }),
  } satisfies Pick<BackgroundRuntimeGovernorService, 'decide'>;
  const systemMode = {
    getSnapshot: healthySystemMode,
    getEffectiveSnapshot: async () => healthySystemMode(),
  } satisfies Pick<SystemModeService, 'getSnapshot' | 'getEffectiveSnapshot'>;
  const signingKeys = {
    getSigningKeys: () => ['synthetic-profile-signing-key'],
  } satisfies Pick<PublisherDialogSigningKeyService, 'getSigningKeys'>;
  const managedEntities = {
    listChats: async () => {
      throw unexpectedBoundary('legacy chat discovery');
    },
    listChannels: async () => {
      throw unexpectedBoundary('legacy channel discovery');
    },
    assertChatAdminAccess: async () => {
      throw unexpectedBoundary('legacy chat authorization');
    },
    assertChannelAdminAccess: async () => {
      throw unexpectedBoundary('legacy channel authorization');
    },
  } satisfies Pick<
    ManagedEntitiesService,
    'listChats' | 'listChannels' | 'assertChatAdminAccess' | 'assertChannelAdminAccess'
  >;
  const publisherPolicy = {
    resolvePublicationTargets: async () => {
      throw unexpectedBoundary('dynamic audience resolution');
    },
  } satisfies Pick<PublisherPolicyService, 'resolvePublicationTargets'>;
  const wakeupQueue = {
    enqueueAfterCommittedMutation: async () => {
      wakeupCount += 1;
    },
  } satisfies Pick<PublisherPublicationWakeupQueueService, 'enqueueAfterCommittedMutation'>;
  const maxClient = {
    getExactMessagePresences: async (requests, requestOptions) => {
      if (typeof requestOptions !== 'object' || requestOptions.botId !== fixture.botId) {
        throw unexpectedBoundary('presence lookup without exact Publisher bot');
      }
      for (const request of requests) {
        if (!targetIds.has(request.chatId)) {
          throw unexpectedBoundary('presence lookup outside fixture audience');
        }
        const currentReceipt = receiptsByTarget.get(request.chatId);
        const seededReceipt =
          fixture.state === 'verification' &&
          request.messageId === `profile-receipt-${request.chatId}`;
        if (request.messageId !== currentReceipt && !seededReceipt) {
          throw unexpectedBoundary('presence lookup without exact known receipt');
        }
      }
      presenceCount += requests.length;
      for (const request of requests) {
        if (presenceMessageIds.length < PRESENCE_SAMPLE_LIMIT)
          presenceMessageIds.push(request.messageId);
      }
      return requests.map((request) => ({ ...request, presence: 'present' as const }));
    },
    resolveMessageLink: async () => null,
    sendMessage: async () => {
      throw unexpectedBoundary('unrouted SEND');
    },
    sendMessageImmediateWithId: async () => {
      throw unexpectedBoundary('unrouted immediate SEND');
    },
    sendMessageImmediateToUser: async () => {
      throw unexpectedBoundary('private SEND');
    },
    uploadImage: async () => {
      throw unexpectedBoundary('image upload');
    },
    uploadVideo: async () => {
      throw unexpectedBoundary('video upload');
    },
  } satisfies Pick<
    MaxClientService,
    | 'getExactMessagePresences'
    | 'resolveMessageLink'
    | 'sendMessage'
    | 'sendMessageImmediateWithId'
    | 'sendMessageImmediateToUser'
    | 'uploadImage'
    | 'uploadVideo'
  >;
  const routedPublication = {
    publish: async (request) => {
      if (request.publisherExactBotId !== fixture.botId) {
        throw unexpectedBoundary('SEND without exact Publisher bot');
      }
      if (!targetIds.has(request.entityId)) {
        throw unexpectedBoundary('SEND outside fixture audience');
      }
      if (receiptsByTarget.has(request.entityId)) {
        throw unexpectedBoundary('duplicate SEND to fixture target');
      }
      if (receiptsByTarget.size >= SENT_TARGET_SAMPLE_LIMIT) {
        throw unexpectedBoundary('SEND beyond the fixed profile turn budget');
      }
      if (!request.prepareAttempt || !request.onDispatchAttempt || !request.beforeSendMutation) {
        throw unexpectedBoundary('Publisher SEND without final guard callbacks');
      }
      publishAttemptCount += 1;
      let job: MaxActionJob = {
        actionType: 'SEND_MESSAGE',
        chatId: request.entityId,
        botId: fixture.botId,
        candidateBotIds: [fixture.botId],
        text: request.text,
        options: request.options,
        trafficClass: request.trafficClass,
        sourceTag: request.sourceTag,
        attempt: 1,
        idempotencyKey: request.logicalIdempotencyKey,
        createdAt: new Date().toISOString(),
      };
      const prepared = await request.prepareAttempt({ botId: fixture.botId, job });
      if (prepared) job = { ...job, ...prepared };
      await request.onDispatchAttempt({ botId: fixture.botId, job });
      await options.beforeSendMutation?.();
      try {
        // FLAG: Synthetic MAX still executes the real final SQL authorization callback.
        await request.beforeSendMutation({ botId: fixture.botId, job });
      } catch (error: unknown) {
        beforeSendRejectedCount += 1;
        throw error;
      }
      sendCount += 1;
      const messageId = `profile-${fixture.broadcastId}-${sendCount}`;
      receiptsByTarget.set(request.entityId, messageId);
      if (sentTargetIds.length < SENT_TARGET_SAMPLE_LIMIT) sentTargetIds.push(request.entityId);
      return {
        messageId,
        chatId: request.entityId,
        botId: fixture.botId,
        url: null,
        candidateBotIds: [fixture.botId],
        routingVersion: null,
      };
    },
  } satisfies Pick<MaxRoutedPublicationService, 'publish'>;

  const module = await Test.createTestingModule({
    providers: [
      { provide: ConfigService, useValue: config },
      { provide: PublisherRuntimeHeartbeatReaderService, useValue: heartbeat },
      { provide: PublisherBindingRefreshQueueService, useValue: refreshQueue },
      { provide: PublisherRuntimeBoundaryService, useValue: boundary },
      { provide: BackgroundRuntimeGovernorService, useValue: governor },
      { provide: SystemModeService, useValue: systemMode },
      { provide: PublisherDialogSigningKeyService, useValue: signingKeys },
      { provide: ManagedEntitiesService, useValue: managedEntities },
      { provide: PublisherPolicyService, useValue: publisherPolicy },
      { provide: PublisherPublicationWakeupQueueService, useValue: wakeupQueue },
      { provide: MaxClientService, useValue: maxClient },
      { provide: MaxRoutedPublicationService, useValue: routedPublication },
      {
        provide: PublisherReadinessService,
        inject: [PublisherRuntimeHeartbeatReaderService, PublisherBindingRefreshQueueService],
        useFactory: (
          heartbeatReader: PublisherRuntimeHeartbeatReaderService,
          bindingRefresh: PublisherBindingRefreshQueueService,
        ) => new PublisherReadinessService(fixture.prisma, heartbeatReader, config, bindingRefresh),
      },
      {
        provide: PublisherDispatchHealthService,
        inject: [PublisherBindingRefreshQueueService],
        useFactory: (bindingRefresh: PublisherBindingRefreshQueueService) =>
          new PublisherDispatchHealthService(config, fixture.prisma, bindingRefresh, healthRedis),
      },
      PublisherDialogLinkService,
      {
        provide: PublisherDialogContextService,
        inject: [PublisherDialogLinkService],
        useFactory: (links: PublisherDialogLinkService) =>
          new PublisherDialogContextService(fixture.prisma, links),
      },
      {
        provide: PublicationContentService,
        inject: [MaxClientService],
        useFactory: (client: MaxClientService) =>
          new PublicationContentService(fixture.prisma, client),
      },
      {
        provide: PublicationPresenterService,
        useFactory: () => new PublicationPresenterService(fixture.prisma),
      },
      {
        provide: PublicationPublisherRoutingService,
        inject: [
          PublisherReadinessService,
          PublisherDialogContextService,
          ManagedEntitiesService,
          PublisherPolicyService,
        ],
        useFactory: (
          readiness: PublisherReadinessService,
          dialogs: PublisherDialogContextService,
          entities: ManagedEntitiesService,
          policy: PublisherPolicyService,
        ) =>
          new PublicationPublisherRoutingService(
            fixture.prisma,
            config,
            readiness,
            dialogs,
            entities,
            policy,
          ),
      },
      {
        provide: AdminManagedBroadcastRuntime,
        inject: [
          MaxClientService,
          MaxRoutedPublicationService,
          PublisherReadinessService,
          PublisherDialogContextService,
          PublisherDispatchHealthService,
          PublisherRuntimeBoundaryService,
          BackgroundRuntimeGovernorService,
        ],
        useFactory: (
          client: MaxClientService,
          routed: MaxRoutedPublicationService,
          readiness: PublisherReadinessService,
          dialogs: PublisherDialogContextService,
          health: PublisherDispatchHealthService,
          runtimeBoundary: PublisherRuntimeBoundaryService,
          backgroundGovernor: BackgroundRuntimeGovernorService,
        ) => {
          const context = {
            publisherTemporalSelectionRollout: 'off',
            prisma: fixture.prisma,
            maxClient: client,
            logger,
            maxRoutedPublicationService: routed,
            publisherReadinessService: readiness,
            publisherDialogContextService: dialogs,
            publisherDispatchHealthService: health,
            publisherRuntimeBoundaryService: runtimeBoundary,
            backgroundRuntimeGovernorService: backgroundGovernor,
            resolveSystemModeSnapshot: async () => healthySystemMode(),
            resolveDeliveryBotAssignment: async () => {
              throw unexpectedBoundary('legacy bot assignment');
            },
            resolvePrivateDeliveryBotId: () => {
              throw unexpectedBoundary('private bot assignment');
            },
            resolvePrivateDialogChatId: async () => {
              throw unexpectedBoundary('private dialog lookup');
            },
            listChatsForMassBroadcast: async () => {
              throw unexpectedBoundary('legacy broadcast discovery');
            },
            assertManagedEntityAdminAccess: async () => {
              throw unexpectedBoundary('legacy managed admin access');
            },
            assertManagedEntityReadAccess: async () => {
              throw unexpectedBoundary('legacy managed read access');
            },
            resolveBroadcastButtonContext: async () => {
              throw unexpectedBoundary('legacy button context');
            },
          } satisfies AdminManagedBroadcastRuntimeContext;
          return new AdminManagedBroadcastRuntime(context, 'PUBLIK_V1');
        },
      },
      {
        provide: ManagedBroadcastService,
        inject: [AdminManagedBroadcastRuntime],
        useFactory: (runtime: AdminManagedBroadcastRuntime) => new ManagedBroadcastService(runtime),
      },
      {
        provide: PublicationService,
        inject: [
          PublicationContentService,
          PublicationPresenterService,
          ManagedEntitiesService,
          ManagedBroadcastService,
          BackgroundRuntimeGovernorService,
          SystemModeService,
          PublicationPublisherRoutingService,
          PublisherPublicationWakeupQueueService,
          ConfigService,
        ],
        useFactory: (
          content: PublicationContentService,
          presenter: PublicationPresenterService,
          entities: ManagedEntitiesService,
          broadcasts: ManagedBroadcastService,
          backgroundGovernor: BackgroundRuntimeGovernorService,
          mode: SystemModeService,
          routing: PublicationPublisherRoutingService,
          wakeups: PublisherPublicationWakeupQueueService,
          runtimeConfig: ConfigService,
        ) =>
          new PublicationService(
            fixture.prisma,
            content,
            presenter,
            entities,
            broadcasts,
            backgroundGovernor,
            mode,
            routing,
            wakeups,
            runtimeConfig,
          ),
      },
    ],
  }).compile();

  const broadcasts = module.get(ManagedBroadcastService);
  const publications = module.get(PublicationService);
  let inFlight: Promise<void> | null = null;
  let closed = false;

  async function execute(turn: ProfileTurn): Promise<void> {
    governorAction = turn === 'maintenance-pause' ? 'pause' : 'run';
    switch (turn) {
      case 'now':
        await broadcasts.processDueImmediatePublicationBroadcasts();
        return;
      case 'targeted':
        await broadcasts.processTargetedImmediatePublicationBroadcasts(
          fixture.publicationId,
          fixture.occurrenceId,
        );
        return;
      case 'deadline':
        await broadcasts.processDueDeadlinePublicationBroadcasts();
        return;
      case 'maintenance-run':
      case 'maintenance-pause':
        await publications.processDuePublications('scheduled');
        return;
    }
  }

  return {
    run(turn) {
      if (closed) return Promise.reject(new Error('Publisher profile runtime is closed'));
      if (inFlight) return Promise.reject(new Error('Publisher profile turns must be sequential'));
      const operation = execute(turn).finally(() => {
        inFlight = null;
      });
      inFlight = operation;
      return operation;
    },
    snapshot: () => ({
      sendCount,
      publishAttemptCount,
      presenceCount,
      refreshCount,
      wakeupCount,
      beforeSendRejectedCount,
      unexpectedBoundaryCount,
      targetSelectionCount: logger.targetSelectionCount,
      dispatchQuantumCount: logger.dispatchQuantumCount,
      warningCount: logger.warningCount,
      errorCount: logger.errorCount,
      sentTargetIds: [...sentTargetIds],
      presenceMessageIds: [...presenceMessageIds],
      sentTargetIdsTruncated: sendCount > sentTargetIds.length,
      presenceMessageIdsTruncated: presenceCount > presenceMessageIds.length,
    }),
    async close() {
      closed = true;
      try {
        await inFlight;
      } finally {
        // FLAG: The fixture owns Prisma; closing this module must not disconnect its client.
        await module.close();
      }
    },
  };
}
