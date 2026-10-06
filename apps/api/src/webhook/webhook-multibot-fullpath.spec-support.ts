import { ModerationRuleFollowupService } from '../moderation/moderation-rule-followup.service';
import { ClosedChatDeleteGuardService } from '../moderation/closed-chat-delete-guard.service';
import { ModerationStateDeleteGuardService } from '../moderation/moderation-state-delete-guard.service';
import { RequiredSubscriptionExecutionGuardService } from '../moderation/required-subscription-execution-guard.service';
import { ModerationRuleSanctionGuardService } from '../moderation/moderation-rule-sanction-guard.service';
import { ModerationSanctionStateFenceService } from '../moderation/moderation-sanction-state-fence.service';
import { GlobalSpammerIntelligenceService } from '../moderation/global-spammer-intelligence.service';
import { StopWordsDeleteGuardService } from '../moderation/stop-words/stop-words-delete-guard.service';
import { MaxMembershipLookupService } from '../max/max-membership-lookup.service';
import { MaxModerationRuleNoticeGuardService } from '../max/max-moderation-rule-notice.guard';
import { MaxRequiredSubscriptionNoticeGuardService } from '../max/max-required-subscription-notice.guard';
import { MaxDuplicateNoticeGuardService } from '../max/max-duplicate-notice.guard';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { from } from 'rxjs';
import Redis from 'ioredis';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import { MaxBotContextService } from '../max/max-bot-context.service';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MaxClientService } from '../max/max-client.service';
import { MaxActionLedgerService } from '../max/max-action-ledger.service';
import { MaxExecutionOwnerReadinessService } from '../max/max-execution-owner-readiness.service';
import { ModerationDeleteIntentAccessWakeService } from '../max/moderation-delete-intent-access-wake.service';
import { buildBotAccessSnapshotPersistence } from '../max/bot-access-snapshot.util';
import { ModerationService } from '../moderation/moderation.service';
import { RuleEngineService } from '../moderation/rule-engine.service';
import { RedisCounterService } from '../moderation/redis-counter.service';
import { SanctionService } from '../moderation/sanction.service';
import { ModerationDeleteIntentService } from '../moderation/moderation-delete-intent.service';
import { MessageLimitsDeleteGuardService } from '../moderation/message-limits-delete-guard.service';
import { ParticipantModerationImmunityService } from '../moderation/participant-moderation-immunity.service';
import { MessageDuplicateHistoryService } from '../moderation/message-duplicate/message-duplicate-history.service';
import {
  MessageDuplicatePolicyService,
  MESSAGE_DUPLICATE_CONTROL_KEY,
} from '../moderation/message-duplicate/message-duplicate-policy.service';
import { MessageDuplicateAuthorizationService } from '../moderation/message-duplicate/message-duplicate-authorization.service';
import { MessageDuplicateDeleteGuardService } from '../moderation/message-duplicate/message-duplicate-delete-guard.service';
import { MessageDuplicateEnforcementService } from '../moderation/message-duplicate/message-duplicate-enforcement.service';
import { MessageDuplicateService } from '../moderation/message-duplicate/message-duplicate.service';
import {
  MessageDuplicateEnqueueService,
  MessageDuplicateOrderingStore,
} from '../moderation/message-duplicate/message-duplicate.queue';
import { WebhookCanonicalExecutionService } from '../moderation/webhook-canonical-execution.service';
import { ActionHealthService } from '../system/action-health.service';
import { createPrismaClient, Prisma } from '../prisma/prisma-client';
import { WebhookService } from './webhook.service';
import { WebhookOutboxService } from './webhook-outbox.service';
import { WebhookParser } from './webhook.parser';
import { WebhookRoutingService } from './webhook-routing.service';
import { ALL_WEBHOOK_QUEUE_NAMES, DEFAULT_WEBHOOK_QUEUE_NAMES } from './webhook-queues';
import { getDefaultWebhookWorkerGroupQueues } from '../runtime/moderation-runtime';
import { WebhookLegacyHoldService } from './webhook-legacy-hold.service';
import { GroupCommandAuthorityService } from '../common/group-command-authority.service';

export type MultibotHarnessOptions = {
  databaseUrl: string;
  redisUrl: string;
  bots: number;
  mode?: 'off' | 'shadow' | 'on';
  quotaProfile?: 'production' | 'fixture';
  recoverDueDeletes?: boolean;
};
export type SimulatedMaxEffect = {
  method: string;
  path: string;
  botId: string;
  messageId?: string;
  body?: unknown;
  params?: Record<string, unknown>;
};

// FLAG: This fixture accepts only disposable local stores and never opens a MAX socket.
// Its HTTP adapter supplies MAX responses; SQL, Redis, BullMQ, rule and mutation services run normally.
export async function createMultibotHarness(options: MultibotHarnessOptions) {
  const dbUrl = new URL(options.databaseUrl);
  const redisUrl = new URL(options.redisUrl);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(dbUrl.hostname) ||
    !dbUrl.pathname.includes('race_test') ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(redisUrl.hostname)
  ) {
    throw new Error('Multibot harness requires disposable local PostgreSQL race_test and Redis');
  }
  const prisma = createPrismaClient(options.databaseUrl, { max: 12, statement_timeout: 15_000 });
  await prisma.$connect();
  const [native] = await prisma.$queryRaw<Array<{ version: string; timezone: string }>>`
    SELECT version(), current_setting('TimeZone') AS timezone
  `;
  if (
    !native?.version.startsWith('PostgreSQL ') ||
    /pglite|wasm/iu.test(native.version) ||
    native.timezone !== 'UTC' ||
    process.env.TZ !== 'UTC'
  ) {
    await prisma.$disconnect();
    throw new Error('Multibot harness requires native PostgreSQL and process/server UTC');
  }
  const redis = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  const previousControl = await redis.get(MESSAGE_DUPLICATE_CONTROL_KEY);
  const previousRevision = await redis.get(`${MESSAGE_DUPLICATE_CONTROL_KEY}:revision`);
  const now = Date.now();
  await redis.set(
    MESSAGE_DUPLICATE_CONTROL_KEY,
    JSON.stringify({
      version: 2,
      revision: 1,
      mode: 'delete_only',
      scope: 'all_enabled_chats',
      chatIds: [],
      effectiveAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString(),
    }),
  );
  await redis.set(`${MESSAGE_DUPLICATE_CONTROL_KEY}:revision`, '1');
  const config = new ConfigService({
    REDIS_URL: options.redisUrl,
    MAX_API_BASE_URL: 'https://max-harness.invalid',
    NODE_ENV: 'test',
    WEBHOOK_CANONICAL_EXECUTION_MODE: options.mode ?? 'shadow',
    MODERATION_DELETE_INTENT_MODE: 'on',
    MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS: '*',
    MAX_ROUTED_MUTATIONS_MODE: 'on',
    MAX_CROSS_BOT_EDIT_DELETE_ENABLED: true,
    MESSAGE_DUPLICATE_ENABLED: true,
    APP_SERVICE_NAME: 'api-moderation',
    MODERATION_BACKGROUND_TASKS_ENABLED: false,
    CHANNEL_AUTO_POST_SCAN_MAX_CHANNELS: 0,
    MAX_API_GLOBAL_RPS: 30,
    MAX_API_CHAT_RPS: options.quotaProfile === 'production' ? 5 : 30,
    MAX_API_MANAGED_REFRESH_RPS: options.quotaProfile === 'production' ? 2 : 30,
    MODERATION_DELETE_INTENT_LEASE_MS: 60_000,
    ENQUEUE_MAX_ATTEMPTS: 120,
  });
  const prefix = `multibot-fixture-${randomUUID()}`;
  const queue = new Queue(`${prefix}-webhook`, {
    connection: redis as unknown as ConnectionOptions,
  });
  const deleteQueue = new Queue(`${prefix}-delete`, {
    connection: redis as unknown as ConnectionOptions,
  });
  const bots = Array.from({ length: options.bots }, (_, index) => ({
    id: `fixture-bot-${index + 1}`,
    token: `fixture-token-${prefix}-${index + 1}`,
    label: `Fixture ${index + 1}`,
    state: 'active',
    username: null,
  }));
  const registry = {
    getDefaultBot: () => bots[0]!,
    getEntryBot: () => bots[0]!,
    getAllBots: () => bots,
    getBotById: (id?: string | null) => bots.find((bot) => bot.id === id) ?? null,
    isKnownBotUserId: (id?: string | null) => bots.some((bot) => bot.id === id),
    resolveBotIdFromUserId: (id?: string | null) => bots.find((bot) => bot.id === id)?.id ?? null,
    getValidationTokens: () => bots.map((bot) => bot.token),
    getValidationTokensForBot: (id: string) =>
      bots.filter((bot) => bot.id === id).map((bot) => bot.token),
    getPublisherBotDescriptor: () => ({ id: 'fixture-publisher' }),
  };
  const context = new MaxBotContextService();
  const counters = new RedisCounterService(config);
  const health = new ActionHealthService(config);
  const legacyHolds = new WebhookLegacyHoldService(prisma as never);
  const ledger = new MaxActionLedgerService(prisma as never, legacyHolds);
  const links = new MaxBotLinkService(
    prisma as never,
    registry as never,
    context,
    new ModerationDeleteIntentAccessWakeService(prisma as never),
    undefined,
    counters,
  );
  const peerRouteRoles: MaxBotLinkService[] = [];
  const createRouteRole = () => {
    const role = new MaxBotLinkService(
      prisma as never,
      registry as never,
      new MaxBotContextService(),
      new ModerationDeleteIntentAccessWakeService(prisma as never),
      undefined,
      counters,
    );
    peerRouteRoles.push(role);
    return role;
  };
  const effects: SimulatedMaxEffect[] = [];
  const requests: SimulatedMaxEffect[] = [];
  const messages = new Map<string, Record<string, unknown>>();
  const deniedBots = new Set<string>();
  const ownMemberProbeOverrides = new Map<string, 'unavailable' | 'permissions_unknown'>();
  const botPermissions = new Map(
    bots.map((bot) => [bot.id, ['read_all_messages', 'write', 'add_remove_members']]),
  );
  const adminUsers = new Set<string>();
  let ambiguousNextSend = false;
  let ambiguousNextDelete = false;
  let ambiguousNextMemberMutation = false;
  const http = {
    request: (request: {
      method: string;
      url: string;
      headers: { Authorization: string };
      params?: Record<string, unknown>;
      data?: Record<string, unknown>;
    }) =>
      from(
        (async () => {
          const url = new URL(request.url);
          if (url.hostname !== 'max-harness.invalid')
            throw new Error('Harness transport refuses external URLs');
          const bot = bots.find((candidate) => candidate.token === request.headers.Authorization);
          if (!bot) throw new Error('Harness transport received an unknown token');
          const path = url.pathname;
          const method = request.method.toLowerCase();
          const messageId = String(request.params?.message_id ?? request.params?.message_ids ?? '');
          const call = {
            method,
            path,
            botId: bot.id,
            ...(messageId ? { messageId } : {}),
            body: request.data,
            ...(method !== 'get' && path.endsWith('/members')
              ? { params: { ...request.params } }
              : {}),
          };
          requests.push(call);
          if (
            deniedBots.has(bot.id) &&
            (path === '/messages' || (method !== 'get' && path.endsWith('/members')))
          ) {
            throw Object.assign(new Error('Simulated MAX chat access denied'), {
              response: { status: 403, data: { code: 'chat.denied' } },
            });
          }
          const member = (id: string, isBot: boolean) => ({
            user_id: id,
            is_bot: isBot,
            is_admin: (isBot && !deniedBots.has(id)) || adminUsers.has(id),
            is_owner: false,
            permissions: isBot && !deniedBots.has(id) ? (botPermissions.get(id) ?? []) : [],
          });
          let data: unknown;
          if (method === 'get' && path.endsWith('/members/me')) {
            const override = ownMemberProbeOverrides.get(bot.id);
            if (override === 'unavailable')
              throw Object.assign(new Error('Simulated own-member lookup unavailable'), {
                response: { status: 503, data: { code: 'fixture.lookup.unavailable' } },
              });
            data =
              override === 'permissions_unknown'
                ? { user_id: bot.id, is_bot: true, is_admin: true, is_owner: false }
                : member(bot.id, true);
          } else if (method === 'get' && path.endsWith('/members/admins'))
            data = {
              members: bots.filter((b) => !deniedBots.has(b.id)).map((b) => member(b.id, true)),
              marker: null,
            };
          else if (method === 'get' && path.endsWith('/members'))
            data = {
              members: String(
                request.params?.user_ids ?? url.searchParams.get('user_ids') ?? 'fixture-user',
              )
                .split(',')
                .map((id) =>
                  member(
                    id,
                    bots.some((b) => b.id === id),
                  ),
                ),
              marker: null,
            };
          else if (method === 'get' && path === '/messages')
            data = { messages: messages.has(messageId) ? [messages.get(messageId)] : [] };
          else if (method === 'get' && path.startsWith('/messages/')) {
            const exactMessageId = decodeURIComponent(path.slice('/messages/'.length));
            if (!messages.has(exactMessageId))
              throw Object.assign(new Error('Simulated exact message absence'), {
                response: { status: 404, data: { code: 'message.not.found' } },
              });
            data = messages.get(exactMessageId);
          } else if (method === 'get' && path.startsWith('/chats/'))
            data = {
              chat_id: path.split('/')[2],
              type: 'chat',
              title: 'Fixture chat',
              participants_count: 2,
            };
          else if (method === 'delete' && path === '/messages') {
            effects.push(call);
            if (ambiguousNextDelete) {
              ambiguousNextDelete = false;
              throw Object.assign(new Error('Simulated ambiguous MAX delete timeout'), {
                code: 'ECONNABORTED',
                request: {},
              });
            }
            messages.delete(messageId);
            data = { success: true };
          } else if (method === 'post' && path === '/messages') {
            effects.push(call);
            if (ambiguousNextSend) {
              ambiguousNextSend = false;
              throw Object.assign(new Error('Simulated ambiguous MAX send timeout'), {
                code: 'ECONNABORTED',
                request: {},
              });
            }
            data = {
              message: {
                recipient: { chat_id: request.params?.chat_id },
                timestamp: Date.now(),
                body: { mid: `fixture-reply-${effects.length}`, text: request.data?.text },
              },
            };
          } else if (method !== 'get' && path.endsWith('/members')) {
            effects.push(call);
            if (ambiguousNextMemberMutation) {
              ambiguousNextMemberMutation = false;
              throw Object.assign(new Error('Simulated ambiguous MAX member mutation timeout'), {
                code: 'ECONNABORTED',
                request: {},
              });
            }
            data = { success: true };
          } else throw new Error(`Unhandled simulated MAX endpoint: ${method} ${path}`);
          return { status: 200, data, headers: {}, config: request };
        })(),
      ),
  };
  const max = new MaxClientService(
    http as never,
    config,
    health,
    registry as never,
    context,
    undefined,
    undefined,
    ledger,
    links,
    undefined,
    undefined,
    undefined,
    undefined,
    new MaxModerationRuleNoticeGuardService(
      prisma as never,
      registry as never,
      new ParticipantModerationImmunityService(prisma as never),
      config,
    ),
    new MaxRequiredSubscriptionNoticeGuardService(
      prisma as never,
      registry as never,
      new ParticipantModerationImmunityService(prisma as never),
      config,
    ),
    new MaxDuplicateNoticeGuardService({ get: () => duplicateGuard } as never),
    legacyHolds,
  );
  const readiness = new MaxExecutionOwnerReadinessService(links, max, counters);
  const canonical = new WebhookCanonicalExecutionService(
    prisma as never,
    readiness,
    undefined,
    legacyHolds,
  );
  const cache = new ChatContextCacheService(prisma as never, config, links);
  const immunity = new ParticipantModerationImmunityService(prisma as never);
  const policy = new MessageDuplicatePolicyService(counters, config);
  const history = new MessageDuplicateHistoryService(counters);
  const ordering = new MessageDuplicateOrderingStore(config);
  const authorization = new MessageDuplicateAuthorizationService(prisma as never, ordering);
  const duplicateGuard = new MessageDuplicateDeleteGuardService(
    prisma as never,
    max,
    links,
    immunity,
    policy,
    history,
    config,
    authorization,
    undefined,
    legacyHolds,
  );
  const lengthGuard = new MessageLimitsDeleteGuardService(
    prisma as never,
    max,
    links as never,
    immunity,
    config,
  );
  const closedGuard = new ClosedChatDeleteGuardService(
    prisma as never,
    max,
    links,
    immunity,
    config,
  );
  const globalPolicy = new GlobalSpammerIntelligenceService(
    prisma as never,
    config,
    registry as never,
    counters,
    undefined,
    undefined,
    legacyHolds,
  );
  const sanctionFence = new ModerationSanctionStateFenceService(prisma as never);
  const stateGuard = new ModerationStateDeleteGuardService(
    prisma as never,
    max,
    links,
    immunity,
    sanctionFence,
    globalPolicy,
    config,
    legacyHolds,
  );
  const membership = new MaxMembershipLookupService(max, config, links, registry as never);
  const subscriptionGuard = new RequiredSubscriptionExecutionGuardService(
    prisma as never,
    max,
    links,
    membership,
    immunity,
    config,
  );
  const sanctionGuard = new ModerationRuleSanctionGuardService(
    prisma as never,
    max,
    links,
    immunity,
    config,
  );
  const stopWordsGuard = new StopWordsDeleteGuardService(
    prisma as never,
    max,
    links,
    immunity,
    config,
  );
  const intents = new ModerationDeleteIntentService(
    prisma as never,
    max,
    links,
    deleteQueue as never,
    config,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    immunity,
    duplicateGuard,
    stopWordsGuard,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    lengthGuard,
    closedGuard,
    stateGuard,
    subscriptionGuard,
    legacyHolds,
  );
  const duplicateService = new MessageDuplicateService(
    policy,
    history,
    new MessageDuplicateEnforcementService(intents, policy, duplicateGuard),
    new MessageDuplicateEnqueueService(),
    authorization,
  );
  const moderation = new ModerationService(
    prisma as never,
    new RuleEngineService(counters),
    new SanctionService(prisma as never),
    max,
    cache,
    undefined,
    config,
    counters,
    undefined,
    undefined,
    undefined,
    links,
    context,
  );
  const ruleFollowups = new ModerationRuleFollowupService(
    prisma as never,
    sanctionGuard,
    links,
    {
      get: () => moderation,
    } as never,
    legacyHolds,
  );
  const groupCommands = new GroupCommandAuthorityService(prisma as never, legacyHolds);
  Object.assign(moderation, {
    legacyHolds,
    injectedWebhookCanonicalExecutionService: canonical,
    moderationDeleteIntentService: intents,
    moderationRuleFollowupService: ruleFollowups,
    maxActionLedgerService: ledger,
    messageDuplicateService: duplicateService,
    participantImmunity: immunity,
    injectedGroupCommandAuthority: groupCommands,
    moderationRuleSanctionGuard: sanctionGuard,
    moderationStateDeleteGuard: stateGuard,
    requiredSubscriptionExecutionGuard: subscriptionGuard,
    membershipLookupService: membership,
    stopWordsDeleteGuard: stopWordsGuard,
    globalSpammerIntelligence: globalPolicy,
  });
  Object.assign(moderation, { injectedExecutionOwnerReadiness: readiness });
  const ingress = new WebhookService(prisma as never, config, links);
  Object.assign(ingress, { executionOwnerReadiness: readiness, maxClient: max, legacyHolds });
  const routing = new WebhookRoutingService(
    prisma as never,
    {
      getWebhookDefaultShardSnapshot: async () => {
        const counts = await queue.getJobCounts(
          'waiting',
          'active',
          'delayed',
          'failed',
          'completed',
        );
        const counters = {
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          delayed: counts.delayed ?? 0,
          failed: counts.failed ?? 0,
          completed: counts.completed ?? 0,
          prioritized: 0,
          paused: 0,
        };
        return {
          generatedAt: new Date().toISOString(),
          webhookDefaultShards: Object.fromEntries(
            DEFAULT_WEBHOOK_QUEUE_NAMES.map((name) => [name, counters]),
          ),
          webhookDefaultWorkerGroups: Object.fromEntries(
            Object.entries(getDefaultWebhookWorkerGroupQueues()).map(([name, queues]) => [
              name,
              { queues, counters },
            ]),
          ),
        };
      },
    } as never,
    config,
  );
  const outbox = new WebhookOutboxService(
    prisma as never,
    config,
    { get: () => queue } as never,
    routing,
    ingress,
    queue as never,
    queue as never,
    queue as never,
    {} as never,
    legacyHolds,
  );
  Object.assign(outbox, {
    queuesByName: Object.fromEntries(ALL_WEBHOOK_QUEUE_NAMES.map((name) => [name, queue])),
  });
  const failures: Error[] = [];
  const processedIds: string[] = [];
  const workerRedis = redis.duplicate({ maxRetriesPerRequest: null });
  const deleteWorkerRedis = redis.duplicate({ maxRetriesPerRequest: null });
  const worker = new Worker(
    queue.name,
    async (job) => {
      await moderation.processWebhookEvent(job.data.webhookEventId);
      processedIds.push(job.data.webhookEventId);
    },
    { connection: workerRedis as unknown as ConnectionOptions, concurrency: 4 },
  );
  worker.on('failed', (_job, error) => failures.push(error));
  const deleteWorker = new Worker(
    deleteQueue.name,
    async (job) => {
      await intents.attemptIntent(job.data.intentId);
    },
    { connection: deleteWorkerRedis as unknown as ConnectionOptions, concurrency: 4 },
  );
  deleteWorker.on('failed', (_job, error) => failures.push(error));
  await Promise.all([
    queue.waitUntilReady(),
    deleteQueue.waitUntilReady(),
    worker.waitUntilReady(),
    deleteWorker.waitUntilReady(),
  ]);
  const chatIds: string[] = [];
  const receiptIds: string[] = [];
  const touchedMessagesByChatId = new Map<string, Set<string>>();
  let nextDeleteSweepAtMs = 0;

  async function seedCatalog(
    count: number,
    settings: Prisma.ChatSettingsUncheckedCreateWithoutChatInput = {},
  ) {
    const added: string[] = [];
    for (let offset = 0; offset < count; offset += 250) {
      const batch = Array.from(
        { length: Math.min(250, count - offset) },
        () => `-${BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 14)}`)}`,
      );
      await prisma.chat.createMany({
        data: batch.map((id) => ({
          id,
          title: 'Local multibot fixture',
          entityType: 'CHAT',
          primaryBotId: bots[0]!.id,
          botId: bots[0]!.id,
          routingState: 'READY',
          routingVersion: 1,
        })),
      });
      await prisma.chatSettings.createMany({
        data: batch.map((chatId) => ({
          chatId,
          deleteSpammersEnabled: false,
          maxMessageLengthEnabled: true,
          maxMessageLength: 20,
          ...settings,
        })),
      });
      const checkedAt = new Date();
      await prisma.chatBotMembership.createMany({
        data: batch.flatMap((chatId) =>
          bots.map((bot, index) => ({
            chatId,
            botId: bot.id,
            role: index === 0 ? ('PRIMARY' as const) : ('STANDBY' as const),
            status: 'ACTIVE' as const,
            ...buildBotAccessSnapshotPersistence(
              {
                isAdmin: true,
                isOwner: false,
                permissionsKnown: true,
                permissions: botPermissions.get(bot.id) ?? [],
              },
              { source: 'fixture', now: checkedAt },
            ),
          })),
        ),
      });
      chatIds.push(...batch);
      added.push(...batch);
    }
    return added;
  }

  async function ingest(input: {
    chatId: string;
    messageId: string;
    text: string;
    botId?: string;
    type?: 'message_created' | 'message_edited';
    at?: number;
    attachments?: unknown[];
  }) {
    const at = input.at ?? Date.now();
    const raw = {
      update_type: input.type ?? 'message_created',
      timestamp: at,
      message: {
        sender: { user_id: 'fixture-user', name: 'Fixture user', is_bot: false },
        recipient: { chat_id: input.chatId, chat_type: 'chat' },
        timestamp: at,
        body: {
          mid: input.messageId,
          text: input.text,
          ...(input.attachments ? { attachments: input.attachments } : {}),
        },
      },
    };
    messages.set(input.messageId, raw.message);
    const touchedMessages = touchedMessagesByChatId.get(input.chatId) ?? new Set<string>();
    touchedMessages.add(input.messageId);
    touchedMessagesByChatId.set(input.chatId, touchedMessages);
    const update = new WebhookParser().parse(raw);
    update.botId = input.botId ?? bots[0]!.id;
    update.updateId = `${prefix}-${randomUUID()}`;
    const result = await ingress.storeReceipt(update, null);
    if (result.webhookEventId) receiptIds.push(result.webhookEventId);
    return result.webhookEventId!;
  }

  async function pumpOnce() {
    if (failures.length) throw failures[0];
    // FLAG: The production SQL sweeper owns future retries even when BullMQ is empty.
    // Keep its cadence and fixture opt-in so deliberate pending/unknown cases stay inspectable.
    if (options.recoverDueDeletes && Date.now() >= nextDeleteSweepAtMs) {
      nextDeleteSweepAtMs = Date.now() + 1_000;
      await intents.sweepDueIntents();
    }
    await ruleFollowups.sweep();
    const candidates = await prisma.webhookEvent.findMany({
      where: {
        id: { in: receiptIds },
        OR: [
          { status: 'RECEIVED' },
          { status: 'QUEUED' },
          { status: 'FAILED', nextEnqueueAt: { lte: new Date() } },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 128,
    });
    if (candidates.length)
      await (
        outbox as unknown as {
          enqueueCandidates: (events: unknown[], concurrency: number) => Promise<unknown>;
        }
      ).enqueueCandidates(
        candidates.map((event) => ({ ...event, priority: 5 })),
        8,
      );
    const pending = await prisma.webhookEvent.count({
      where: { id: { in: receiptIds }, status: { in: ['RECEIVED', 'QUEUED', 'FAILED'] } },
    });
    const queued = await deleteQueue.getJobCounts('waiting', 'active', 'delayed');
    const unfinishedDeletes =
      options.recoverDueDeletes && touchedMessagesByChatId.size
        ? await prisma.moderationDeleteIntent.count({
            where: {
              OR: [...touchedMessagesByChatId].map(([chatId, messageIds]) => ({
                chatId,
                messageId: { in: [...messageIds] },
              })),
              status: {
                in: ['PENDING', 'RETRYABLE', 'WAITING_CAPABILITY', 'AMBIGUOUS', 'IN_PROGRESS'],
              },
            },
          })
        : 0;
    const pendingFollowups = await prisma.moderationRuleFollowup.count({
      where: { chatId: { in: chatIds }, status: { in: ['READY', 'RETRYABLE', 'IN_PROGRESS'] } },
    });
    return (
      pendingFollowups +
      pending +
      (queued.waiting ?? 0) +
      (queued.active ?? 0) +
      (queued.delayed ?? 0) +
      unfinishedDeletes
    );
  }

  async function drain(maxMs = 15_000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (!(await pumpOnce())) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Multibot drain exceeded ${maxMs} ms; effects=${effects.length}`);
  }

  async function waitForConfirmedDelete(chatId: string, messageId: string, maxMs = 15_000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (failures.length) throw failures[0];
      const intent = await prisma.moderationDeleteIntent.findUnique({
        where: { chatId_messageId: { chatId, messageId } },
        select: {
          id: true,
          status: true,
          remoteDeleteSucceededAt: true,
          reasons: {
            where: { ruleCode: 'DUPLICATE_DELETE' },
            select: { metadata: true },
            take: 65,
          },
        },
      });
      // FLAG: A late-notice fault must follow our actual verified DELETE and completion
      // of this fixture's isolated delete queue. Never drain the blocked webhook job here.
      const queued = await deleteQueue.getJobCounts('waiting', 'active', 'delayed');
      const verified = intent?.reasons.some(
        (reason) =>
          (reason.metadata as Record<string, unknown> | null)?.moderationDeleteVerified === true,
      );
      if (
        intent?.status === 'SUCCEEDED' &&
        intent.remoteDeleteSucceededAt &&
        verified &&
        !messages.has(messageId) &&
        (queued.waiting ?? 0) + (queued.active ?? 0) + (queued.delayed ?? 0) === 0
      ) {
        if (failures.length) throw failures[0];
        return intent;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Confirmed duplicate DELETE did not settle within ${maxMs} ms`);
  }

  async function demote(chatId: string, botId: string) {
    deniedBots.add(botId);
    await links.recordBotAccessProbe({
      chatId,
      botId,
      access: null,
      checkedAt: new Date(),
      source: 'fixture-demotion',
      allowMembershipRecovery: false,
    });
    await cache.invalidate(chatId);
  }

  async function dispose() {
    await Promise.all([worker.close(), deleteWorker.close()]);
    await Promise.all([workerRedis.quit(), deleteWorkerRedis.quit()]);
    await queue.obliterate({ force: true });
    await deleteQueue.obliterate({ force: true });
    await Promise.all([queue.close(), deleteQueue.close()]);
    await ingress.onModuleDestroy();
    await readiness.onModuleDestroy();
    moderation.onModuleDestroy();
    outbox.onModuleDestroy();
    links.onModuleDestroy();
    for (const role of peerRouteRoles) role.onModuleDestroy();
    await Promise.all([
      max.onModuleDestroy(),
      cache.onModuleDestroy(),
      health.onModuleDestroy(),
      counters.onModuleDestroy(),
      ordering.onModuleDestroy(),
      membership.onModuleDestroy(),
      globalPolicy.onModuleDestroy(),
    ]);
    if (previousControl === null) await redis.del(MESSAGE_DUPLICATE_CONTROL_KEY);
    else await redis.set(MESSAGE_DUPLICATE_CONTROL_KEY, previousControl);
    if (previousRevision === null) await redis.del(`${MESSAGE_DUPLICATE_CONTROL_KEY}:revision`);
    else await redis.set(`${MESSAGE_DUPLICATE_CONTROL_KEY}:revision`, previousRevision);
    await prisma.webhookExecutionClaim.deleteMany({
      where: { webhookEventId: { in: receiptIds } },
    });
    await prisma.webhookEvent.deleteMany({ where: { id: { in: receiptIds } } });
    for (let offset = 0; offset < chatIds.length; offset += 1000)
      await prisma.chat.deleteMany({ where: { id: { in: chatIds.slice(offset, offset + 1000) } } });
    await prisma.maxActionLedgerEntry.deleteMany({ where: { chatId: { in: chatIds } } });
    await prisma.$disconnect();
    await redis.quit();
  }

  return {
    prisma,
    legacyHolds,
    redis,
    bots,
    config,
    links,
    max,
    canonical,
    intents,
    ruleFollowups,
    stateGuard,
    globalPolicy,
    subscriptionGuard,
    sanctionGuard,
    membership,
    deleteQueue,
    ingress,
    outbox,
    moderation,
    cache,
    routing,
    duplicateService,
    authorization,
    duplicateGuard,
    history,
    ledger,
    readiness,
    createRouteRole,
    groupCommands,
    effects,
    requests,
    processedIds,
    failures,
    messages,
    seedCatalog,
    ingest,
    pumpOnce,
    drain,
    waitForConfirmedDelete,
    demote,
    dispose,
    pause: () => worker.pause(),
    resume: () => worker.resume(),
    ambiguousNextSend: () => {
      ambiguousNextSend = true;
    },
    ambiguousNextDelete: () => {
      ambiguousNextDelete = true;
    },
    ambiguousNextMemberMutation: () => {
      ambiguousNextMemberMutation = true;
    },
    denyBot: (botId: string) => {
      deniedBots.add(botId);
    },
    allowBot: (botId: string) => {
      deniedBots.delete(botId);
    },
    setOwnMemberProbe: (botId: string, result: 'unavailable' | 'permissions_unknown' | null) => {
      if (result === null) ownMemberProbeOverrides.delete(botId);
      else ownMemberProbeOverrides.set(botId, result);
    },
    allowAdminUser: (userId: string) => {
      adminUsers.add(userId);
    },
    setBotPermissions: (botId: string, permissions: string[]) => {
      botPermissions.set(botId, [...permissions]);
    },
    mediaCoverage: 'ingress-and-caption-rules-without-native-photo-or-ocr' as const,
    receiptIds,
    chatIds,
  };
}

export type MultibotHarness = Awaited<ReturnType<typeof createMultibotHarness>>;
