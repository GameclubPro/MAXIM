import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  BotWebhookOperationalDiagnostics,
  BotWebhookSubscriptionSnapshot,
  WebhookSubscriptionSnapshot,
} from '@maxim/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { ChatBotMembershipStatus } from '../prisma/prisma-client';
import { getAppRole, roleRunsIngress } from '../runtime/app-role';
import {
  WebhookSubscriptionStatusService,
  type WebhookSubscriptionBotSyncState,
  type WebhookSubscriptionSyncState,
} from '../system/webhook-subscription-status.service';
import { MAX_API_SOURCE_TAGS, MaxClientService } from './max-client.service';
import { MaxBotRegistryService, type MaxBotDefinition } from './max-bot-registry.service';
import { MAX_REQUIRED_WEBHOOK_UPDATE_TYPES } from './max-webhook-subscription.constants';

const DEFAULT_RECONCILE_INTERVAL_MS = 60 * 1_000;
const DEFAULT_STALE_INGRESS_MS = 5 * 60 * 1_000;
const DEFAULT_STALE_RECREATE_COOLDOWN_MS = 10 * 60 * 1_000;
const REQUIRED_WEBHOOK_UPDATE_TYPES_SET = new Set<string>(MAX_REQUIRED_WEBHOOK_UPDATE_TYPES);

type BotWebhookMembershipDiagnostics = {
  activeMemberships: number;
  lastMembershipWebhookAt: string | null;
};

@Injectable()
export class MaxWebhookSubscriptionReconcilerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaxWebhookSubscriptionReconcilerService.name);
  private readonly enabled = roleRunsIngress(getAppRole());
  private readonly reconcileIntervalMs: number;
  private readonly staleIngressMs: number;
  private readonly staleRecreateCooldownMs: number;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(
    private readonly maxClient: MaxClientService,
    private readonly maxBotRegistry: MaxBotRegistryService,
    private readonly webhookSubscriptionStatusService: WebhookSubscriptionStatusService,
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.reconcileIntervalMs = configService.get<number>(
      'MAX_WEBHOOK_RECONCILE_INTERVAL_MS',
      DEFAULT_RECONCILE_INTERVAL_MS,
    );
    this.staleIngressMs = configService.get<number>(
      'MAX_WEBHOOK_STALE_INGRESS_MS',
      DEFAULT_STALE_INGRESS_MS,
    );
    this.staleRecreateCooldownMs = configService.get<number>(
      'MAX_WEBHOOK_STALE_RECREATE_COOLDOWN_MS',
      DEFAULT_STALE_RECREATE_COOLDOWN_MS,
    );
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    this.timer = setInterval(() => {
      void this.reconcile('scheduled');
    }, this.reconcileIntervalMs);
    this.timer.unref();

    await this.reconcile('startup');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async reconcile(reason: 'startup' | 'scheduled'): Promise<void> {
    if (this.inFlight) {
      return;
    }

    this.inFlight = true;
    try {
      const syncState = await this.webhookSubscriptionStatusService.getSyncState();
      const operationalBots = this.getOperationalBots();
      const botIds = operationalBots.map((bot) => bot.id);
      const [latestRecordedIncomingByBot, membershipDiagnosticsByBot] = await Promise.all([
        this.resolveLatestRecordedIncomingWebhookAtByBot(syncState, botIds),
        this.resolveMembershipDiagnosticsByBot(botIds),
      ]);
      const latestRecordedIncomingWebhookAt = this.resolveLatestIso(
        Object.values(latestRecordedIncomingByBot),
      );
      const botResults = await Promise.all(
        operationalBots.map((bot) =>
          this.reconcileBot(
            bot,
            syncState?.bots?.[bot.id] ?? null,
            {
              latestRecordedIncomingWebhookAt: latestRecordedIncomingByBot[bot.id] ?? null,
              membershipDiagnostics: membershipDiagnosticsByBot[bot.id] ?? {
                activeMemberships: 0,
                lastMembershipWebhookAt: null,
              },
            },
            reason,
          ),
        ),
      );
      const botSnapshots = Object.fromEntries(
        botResults.map((result) => [result.snapshot.botId, result.snapshot]),
      );
      const lastGlobalAutoRecreateAt =
        botResults
          .map((result) => result.syncState.lastAutoRecreateAt)
          .filter((value): value is string => typeof value === 'string')
          .sort((left, right) => right.localeCompare(left))[0] ??
        syncState?.lastGlobalAutoRecreateAt ??
        null;

      await this.webhookSubscriptionStatusService.writeSyncState({
        bots: Object.fromEntries(
          botResults.map((result) => [result.snapshot.botId, result.syncState]),
        ),
        lastGlobalIncomingWebhookAt: latestRecordedIncomingWebhookAt,
        lastGlobalAutoRecreateAt,
      });
      await this.webhookSubscriptionStatusService.writeSnapshot(
        this.buildAggregateSnapshot(botSnapshots, reason),
      );
    } catch (error: unknown) {
      const previous =
        (await this.webhookSubscriptionStatusService.getSnapshot()) ??
        this.createDisabledSnapshot('Webhook coverage ещё не была синхронизирована.');
      const lastError = error instanceof Error ? error.message : String(error);
      await this.webhookSubscriptionStatusService.writeSnapshot({
        ...previous,
        status: previous.status === 'critical' ? 'critical' : 'warning',
        lastError,
        note: 'Последняя проверка webhook subscription завершилась с ошибкой.',
      });
      this.logger.warn(
        {
          reason,
          err: lastError,
        },
        'Failed to reconcile MAX webhook subscriptions',
      );
    } finally {
      this.inFlight = false;
    }
  }

  private getOperationalBots(): MaxBotDefinition[] {
    if (typeof this.maxBotRegistry.getOperationalBots === 'function') {
      return [...this.maxBotRegistry.getOperationalBots()];
    }

    if (typeof this.maxBotRegistry.getAllBots === 'function') {
      return [...this.maxBotRegistry.getAllBots()];
    }

    return [];
  }

  private resolveStatus(input: {
    configured: boolean;
    hasCurrentSubscription: boolean;
    missingUpdateTypes: readonly string[];
    extraUpdateTypes: readonly string[];
    otherSubscriptionsCount: number;
    staleIngress: boolean;
    operationalIssues: readonly string[];
  }): WebhookSubscriptionSnapshot['status'] {
    if (!input.configured) {
      return 'disabled';
    }

    if (!input.hasCurrentSubscription || input.missingUpdateTypes.length > 0) {
      return 'critical';
    }

    if (input.extraUpdateTypes.length > 0 || input.otherSubscriptionsCount > 0) {
      return 'warning';
    }

    if (input.staleIngress) {
      return 'warning';
    }

    if (input.operationalIssues.length > 0) {
      return 'warning';
    }

    return 'healthy';
  }

  private resolveAggregateStatus(
    snapshots: readonly BotWebhookSubscriptionSnapshot[],
  ): WebhookSubscriptionSnapshot['status'] {
    if (snapshots.length === 0) {
      return 'disabled';
    }

    if (snapshots.every((snapshot) => snapshot.status === 'disabled')) {
      return 'disabled';
    }

    if (snapshots.some((snapshot) => snapshot.status === 'critical')) {
      return 'critical';
    }

    if (
      snapshots.some((snapshot) => snapshot.status === 'warning' || snapshot.status === 'disabled')
    ) {
      return 'warning';
    }

    return 'healthy';
  }

  private async reconcileBot(
    bot: MaxBotDefinition,
    syncState: WebhookSubscriptionBotSyncState | null,
    botState: {
      latestRecordedIncomingWebhookAt: string | null;
      membershipDiagnostics: BotWebhookMembershipDiagnostics;
    },
    reason: 'startup' | 'scheduled',
  ): Promise<{
    snapshot: BotWebhookSubscriptionSnapshot;
    syncState: WebhookSubscriptionBotSyncState;
  }> {
    const target = this.maxClient.getConfiguredWebhookSubscriptionTarget(bot.id);
    const checkedAt = new Date().toISOString();
    const headerSecretFingerprint = this.maxBotRegistry.computeWebhookHeaderSecretFingerprint(
      bot.id,
    );

    if (!target.url) {
      return {
        snapshot: {
          botId: bot.id,
          status: 'disabled',
          configured: false,
          url: null,
          checkedAt,
          reconciledAt: null,
          requiredUpdateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
          actualUpdateTypes: [],
          missingUpdateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
          extraUpdateTypes: [],
          otherSubscriptionsCount: 0,
          lastError: null,
          note: 'Webhook URL для этого бота не сконфигурирован.',
        },
        syncState: {
          configuredUrl: null,
          headerSecretFingerprint,
          updatedAt: checkedAt,
          lastIncomingWebhookAt:
            botState.latestRecordedIncomingWebhookAt ?? syncState?.lastIncomingWebhookAt ?? null,
          lastAutoRecreateAt: syncState?.lastAutoRecreateAt ?? null,
        },
      };
    }

    const existing = await this.maxClient.listWebhookSubscriptions({
      trafficClass: 'background',
      botId: bot.id,
      sourceTag: MAX_API_SOURCE_TAGS.WEBHOOK_SUBSCRIPTION_RECONCILE,
    });
    const current = existing.find((item) =>
      this.maxClient.matchesConfiguredWebhookUrl(item.url, bot.id),
    );
    const actualUpdateTypes = [...(current?.updateTypes ?? [])].sort();
    const missingUpdateTypes = MAX_REQUIRED_WEBHOOK_UPDATE_TYPES.filter(
      (type) => !actualUpdateTypes.includes(type),
    );
    const otherSubscriptionsCount = existing.filter(
      (item) => !this.maxClient.matchesConfiguredWebhookUrl(item.url, bot.id),
    ).length;
    const previousConfiguredUrl =
      syncState?.configuredUrl && syncState.configuredUrl !== target.url
        ? syncState.configuredUrl
        : null;
    const shouldRotateWebhookSecret =
      Boolean(current) &&
      bot.webhookHeaderSecrets.length > 1 &&
      (!syncState?.headerSecretFingerprint ||
        syncState.headerSecretFingerprint !== headerSecretFingerprint);
    const staleIngress = this.isStaleIngress(botState.latestRecordedIncomingWebhookAt);
    const shouldAutoRecreateStaleIngress =
      Boolean(current) &&
      !shouldRotateWebhookSecret &&
      missingUpdateTypes.length === 0 &&
      staleIngress &&
      this.canAutoRecreateStaleIngress(syncState?.lastAutoRecreateAt ?? null);

    let reconciledAt: string | null = null;
    let effectiveOtherSubscriptionsCount = otherSubscriptionsCount;
    const deletedSubscriptionUrls = new Set<string>();
    if (shouldRotateWebhookSecret) {
      await this.maxClient.deleteWebhookSubscription(target.url, {
        trafficClass: 'background',
        botId: bot.id,
        sourceTag: MAX_API_SOURCE_TAGS.WEBHOOK_SUBSCRIPTION_RECONCILE,
      });
      await this.maxClient.ensureWebhookSubscription([...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES], {
        trafficClass: 'background',
        botId: bot.id,
        sourceTag: MAX_API_SOURCE_TAGS.WEBHOOK_SUBSCRIPTION_RECONCILE,
      });
      reconciledAt = new Date().toISOString();
    } else if (shouldAutoRecreateStaleIngress) {
      await this.maxClient.deleteWebhookSubscription(target.url, {
        trafficClass: 'background',
        botId: bot.id,
        sourceTag: MAX_API_SOURCE_TAGS.WEBHOOK_SUBSCRIPTION_RECONCILE,
      });
      await this.maxClient.ensureWebhookSubscription([...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES], {
        trafficClass: 'background',
        botId: bot.id,
        sourceTag: MAX_API_SOURCE_TAGS.WEBHOOK_SUBSCRIPTION_RECONCILE,
      });
      reconciledAt = new Date().toISOString();
    } else if (!current || missingUpdateTypes.length > 0) {
      await this.maxClient.ensureWebhookSubscription([...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES], {
        trafficClass: 'background',
        botId: bot.id,
        sourceTag: MAX_API_SOURCE_TAGS.WEBHOOK_SUBSCRIPTION_RECONCILE,
      });
      reconciledAt = new Date().toISOString();
    }

    if (previousConfiguredUrl) {
      const hasPreviousConfiguredUrl = existing.some((item) => item.url === previousConfiguredUrl);
      if (hasPreviousConfiguredUrl) {
        await this.maxClient.deleteWebhookSubscription(previousConfiguredUrl, {
          trafficClass: 'background',
          botId: bot.id,
          sourceTag: MAX_API_SOURCE_TAGS.WEBHOOK_SUBSCRIPTION_RECONCILE,
        });
        deletedSubscriptionUrls.add(previousConfiguredUrl);
        reconciledAt = reconciledAt ?? new Date().toISOString();
        effectiveOtherSubscriptionsCount = Math.max(0, effectiveOtherSubscriptionsCount - 1);
      }
    }

    for (const subscription of existing) {
      if (
        deletedSubscriptionUrls.has(subscription.url) ||
        this.maxClient.matchesConfiguredWebhookUrl(subscription.url, bot.id) ||
        !this.isOwnedBotWebhookSubscriptionUrl(subscription.url, bot.id)
      ) {
        continue;
      }

      await this.maxClient.deleteWebhookSubscription(subscription.url, {
        trafficClass: 'background',
        botId: bot.id,
        sourceTag: MAX_API_SOURCE_TAGS.WEBHOOK_SUBSCRIPTION_RECONCILE,
      });
      deletedSubscriptionUrls.add(subscription.url);
      reconciledAt = reconciledAt ?? new Date().toISOString();
      effectiveOtherSubscriptionsCount = Math.max(0, effectiveOtherSubscriptionsCount - 1);
    }

    const refreshedCurrent =
      !current || missingUpdateTypes.length > 0 || shouldRotateWebhookSecret
        ? {
            url: target.url,
            updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES].sort(),
          }
        : current;
    const refreshedActualUpdateTypes = [...refreshedCurrent.updateTypes].sort();
    const operationalDiagnostics = this.buildOperationalDiagnostics({
      bot,
      hasCurrentSubscription: Boolean(refreshedCurrent.url),
      latestRecordedIncomingWebhookAt: botState.latestRecordedIncomingWebhookAt,
      membershipDiagnostics: botState.membershipDiagnostics,
    });
    const operationalIssues = operationalDiagnostics?.issueCodes ?? [];

    return {
      snapshot: {
        botId: bot.id,
        status: this.resolveStatus({
          configured: true,
          hasCurrentSubscription: Boolean(refreshedCurrent.url),
          missingUpdateTypes:
            reconciledAt === null
              ? missingUpdateTypes
              : MAX_REQUIRED_WEBHOOK_UPDATE_TYPES.filter(
                  (type) => !refreshedActualUpdateTypes.includes(type),
                ),
          extraUpdateTypes: refreshedActualUpdateTypes.filter(
            (type) => !REQUIRED_WEBHOOK_UPDATE_TYPES_SET.has(type),
          ),
          otherSubscriptionsCount: effectiveOtherSubscriptionsCount,
          staleIngress,
          operationalIssues,
        }),
        configured: true,
        url: target.maskedUrl,
        checkedAt,
        reconciledAt,
        requiredUpdateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
        actualUpdateTypes: refreshedActualUpdateTypes,
        missingUpdateTypes: MAX_REQUIRED_WEBHOOK_UPDATE_TYPES.filter(
          (type) => !refreshedActualUpdateTypes.includes(type),
        ),
        extraUpdateTypes: refreshedActualUpdateTypes.filter(
          (type) => !REQUIRED_WEBHOOK_UPDATE_TYPES_SET.has(type),
        ),
        otherSubscriptionsCount: effectiveOtherSubscriptionsCount,
        lastError: null,
        note:
          this.buildOperationalBotNote(bot.id, operationalDiagnostics) ??
          this.buildBotNote({
            botId: bot.id,
            reason,
            staleIngressAt: botState.latestRecordedIncomingWebhookAt,
            autoRecreatedAt: shouldAutoRecreateStaleIngress ? reconciledAt : null,
          }),
        ...(operationalDiagnostics ? { operationalDiagnostics } : {}),
      },
      syncState: {
        configuredUrl: target.url,
        headerSecretFingerprint,
        updatedAt: checkedAt,
        lastIncomingWebhookAt:
          botState.latestRecordedIncomingWebhookAt ?? syncState?.lastIncomingWebhookAt ?? null,
        lastAutoRecreateAt:
          shouldAutoRecreateStaleIngress && reconciledAt
            ? reconciledAt
            : (syncState?.lastAutoRecreateAt ?? null),
      },
    };
  }

  private buildOperationalDiagnostics(params: {
    bot: MaxBotDefinition;
    hasCurrentSubscription: boolean;
    latestRecordedIncomingWebhookAt: string | null;
    membershipDiagnostics: BotWebhookMembershipDiagnostics;
  }): BotWebhookOperationalDiagnostics | null {
    if (params.bot.state !== 'active') {
      return null;
    }

    const issueCodes: BotWebhookOperationalDiagnostics['issueCodes'] = [];
    if (params.hasCurrentSubscription && params.membershipDiagnostics.activeMemberships === 0) {
      issueCodes.push('no-active-memberships');
    }
    if (params.hasCurrentSubscription && !params.latestRecordedIncomingWebhookAt) {
      issueCodes.push('no-incoming-webhooks');
    }

    return {
      lifecycleState: params.bot.state,
      activeMemberships: params.membershipDiagnostics.activeMemberships,
      hasCurrentSubscription: params.hasCurrentSubscription,
      lastIncomingWebhookAt: params.latestRecordedIncomingWebhookAt,
      lastMembershipWebhookAt: params.membershipDiagnostics.lastMembershipWebhookAt,
      issueCodes,
    };
  }

  private isOwnedBotWebhookSubscriptionUrl(url: string, botId: string): boolean {
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
      return (
        segments.length >= 5 &&
        segments[0] === 'api' &&
        segments[1] === 'webhook' &&
        segments[2] === 'max' &&
        decodeURIComponent(segments[3] ?? '') === botId &&
        segments[4].length > 0
      );
    } catch {
      return false;
    }
  }

  private buildOperationalBotNote(
    botId: string,
    diagnostics: BotWebhookOperationalDiagnostics | null,
  ): string | null {
    const issueCodes = diagnostics?.issueCodes ?? [];
    if (issueCodes.length === 0) {
      return null;
    }

    const details: string[] = [];
    if (issueCodes.includes('no-active-memberships')) {
      details.push('нет active chat_bot_memberships');
    }
    if (issueCodes.includes('no-incoming-webhooks')) {
      details.push('нет записанных входящих webhook');
    }

    return `Активный бот ${botId} имеет webhook subscription, но ${details.join(' и ')}.`;
  }

  private buildBotNote(params: {
    botId: string;
    reason: 'startup' | 'scheduled';
    staleIngressAt: string | null;
    autoRecreatedAt: string | null;
  }): string {
    if (this.isStaleIngress(params.staleIngressAt)) {
      if (params.autoRecreatedAt) {
        return `Свежие входящие webhook по ${params.botId} не наблюдались с ${params.staleIngressAt}; подписка была пересоздана автоматически.`;
      }

      return `Свежие входящие webhook по ${params.botId} не наблюдались с ${params.staleIngressAt}; ожидается автопересоздание после cooldown.`;
    }

    return params.reason === 'startup'
      ? `Webhook coverage для ${params.botId} проверена при старте ingress.`
      : `Webhook coverage для ${params.botId} поддерживается фоновым reconcile.`;
  }

  private isStaleIngress(lastIngressAt: string | null): boolean {
    if (!lastIngressAt) {
      return false;
    }

    const lastIngressAtMs = Date.parse(lastIngressAt);
    if (!Number.isFinite(lastIngressAtMs)) {
      return false;
    }

    return Date.now() - lastIngressAtMs >= this.staleIngressMs;
  }

  private canAutoRecreateStaleIngress(lastAutoRecreateAt: string | null): boolean {
    if (!lastAutoRecreateAt) {
      return true;
    }

    const lastAutoRecreateAtMs = Date.parse(lastAutoRecreateAt);
    if (!Number.isFinite(lastAutoRecreateAtMs)) {
      return true;
    }

    return Date.now() - lastAutoRecreateAtMs >= this.staleRecreateCooldownMs;
  }

  private async resolveLatestRecordedIncomingWebhookAtByBot(
    syncState: WebhookSubscriptionSyncState | null,
    botIds: readonly string[],
  ): Promise<Record<string, string | null>> {
    const normalizedBotIds = [...new Set(botIds.map((botId) => botId.trim()).filter(Boolean))];
    if (normalizedBotIds.length === 0) {
      return {};
    }

    const latestMembershipRows = await this.prisma.chatBotMembership.groupBy({
      by: ['botId'],
      _max: {
        lastWebhookAt: true,
      },
      where: {
        botId: {
          in: normalizedBotIds,
        },
        lastWebhookAt: {
          not: null,
        },
      },
    });
    const latestMembershipByBot = new Map(
      latestMembershipRows.map((row) => [row.botId, row._max.lastWebhookAt?.toISOString() ?? null]),
    );

    return Object.fromEntries(
      normalizedBotIds.map((botId) => [
        botId,
        this.resolveLatestIso([
          syncState?.bots?.[botId]?.lastIncomingWebhookAt ?? null,
          latestMembershipByBot.get(botId) ?? null,
        ]),
      ]),
    );
  }

  private async resolveMembershipDiagnosticsByBot(
    botIds: readonly string[],
  ): Promise<Record<string, BotWebhookMembershipDiagnostics>> {
    const normalizedBotIds = [...new Set(botIds.map((botId) => botId.trim()).filter(Boolean))];
    if (normalizedBotIds.length === 0) {
      return {};
    }

    const rows = await this.prisma.chatBotMembership.groupBy({
      by: ['botId'],
      _count: {
        _all: true,
      },
      _max: {
        lastWebhookAt: true,
      },
      where: {
        botId: {
          in: normalizedBotIds,
        },
        status: ChatBotMembershipStatus.ACTIVE,
      },
    });
    const byBot = new Map(
      rows.map((row) => [
        row.botId,
        {
          activeMemberships: row._count._all,
          lastMembershipWebhookAt: row._max.lastWebhookAt?.toISOString() ?? null,
        } satisfies BotWebhookMembershipDiagnostics,
      ]),
    );

    return Object.fromEntries(
      normalizedBotIds.map((botId) => [
        botId,
        byBot.get(botId) ?? {
          activeMemberships: 0,
          lastMembershipWebhookAt: null,
        },
      ]),
    );
  }

  private resolveLatestIso(values: Iterable<string | null | undefined>): string | null {
    let latest: string | null = null;
    for (const value of values) {
      if (!value) {
        continue;
      }

      if (!latest || value.localeCompare(latest) > 0) {
        latest = value;
      }
    }

    return latest;
  }

  private buildAggregateSnapshot(
    snapshotsByBot: Record<string, BotWebhookSubscriptionSnapshot>,
    reason: 'startup' | 'scheduled',
  ): WebhookSubscriptionSnapshot {
    const snapshots = Object.values(snapshotsByBot);
    const aggregateActualUpdateTypes = Array.from(
      new Set(snapshots.flatMap((snapshot) => snapshot.actualUpdateTypes)),
    ).sort();
    const aggregateMissingUpdateTypes = Array.from(
      new Set(snapshots.flatMap((snapshot) => snapshot.missingUpdateTypes)),
    ).sort();
    const aggregateExtraUpdateTypes = Array.from(
      new Set(snapshots.flatMap((snapshot) => snapshot.extraUpdateTypes)),
    ).sort();
    const reconciledAtCandidates = snapshots
      .map((snapshot) => snapshot.reconciledAt)
      .filter((value): value is string => typeof value === 'string');
    const lastError = snapshots.find((snapshot) => snapshot.lastError)?.lastError ?? null;
    const defaultBotId =
      typeof this.maxBotRegistry.getDefaultBot === 'function'
        ? this.maxBotRegistry.getDefaultBot().id
        : (snapshots[0]?.botId ?? null);
    const defaultBotUrl =
      snapshots.find((snapshot) => snapshot.botId === defaultBotId)?.url ?? null;

    return {
      status: this.resolveAggregateStatus(snapshots),
      configured: snapshots.length > 0 && snapshots.every((snapshot) => snapshot.configured),
      url: snapshots.length === 1 ? (snapshots[0]?.url ?? null) : defaultBotUrl,
      checkedAt: new Date().toISOString(),
      reconciledAt:
        reconciledAtCandidates.length > 0
          ? (reconciledAtCandidates.sort((left, right) => right.localeCompare(left))[0] ?? null)
          : null,
      requiredUpdateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
      actualUpdateTypes: aggregateActualUpdateTypes,
      missingUpdateTypes: aggregateMissingUpdateTypes,
      extraUpdateTypes: aggregateExtraUpdateTypes,
      otherSubscriptionsCount: snapshots.reduce(
        (total, snapshot) => total + snapshot.otherSubscriptionsCount,
        0,
      ),
      lastError,
      note:
        snapshots.length <= 1
          ? reason === 'startup'
            ? 'Webhook coverage проверена при старте ingress.'
            : 'Webhook coverage поддерживается фоновым reconcile.'
          : `Webhook coverage синхронизирована для ${snapshots.length} ботов.`,
      botCount: snapshots.length,
      bots: snapshotsByBot,
      operationalDiagnostics: this.buildAggregateOperationalDiagnostics(snapshots),
    };
  }

  private buildAggregateOperationalDiagnostics(
    snapshots: readonly BotWebhookSubscriptionSnapshot[],
  ): NonNullable<WebhookSubscriptionSnapshot['operationalDiagnostics']> {
    const warningBotIds: string[] = [];
    const noActiveMembershipBotIds: string[] = [];
    const noIncomingWebhookBotIds: string[] = [];

    for (const snapshot of snapshots) {
      const issueCodes = snapshot.operationalDiagnostics?.issueCodes ?? [];
      if (issueCodes.length === 0) {
        continue;
      }

      warningBotIds.push(snapshot.botId);
      if (issueCodes.includes('no-active-memberships')) {
        noActiveMembershipBotIds.push(snapshot.botId);
      }
      if (issueCodes.includes('no-incoming-webhooks')) {
        noIncomingWebhookBotIds.push(snapshot.botId);
      }
    }

    return {
      warningBotCount: warningBotIds.length,
      warningBotIds,
      noActiveMembershipBotIds,
      noIncomingWebhookBotIds,
    };
  }

  private createDisabledSnapshot(note: string): WebhookSubscriptionSnapshot {
    return {
      status: 'disabled',
      configured: false,
      url: null,
      checkedAt: null,
      reconciledAt: null,
      requiredUpdateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
      actualUpdateTypes: [],
      missingUpdateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
      extraUpdateTypes: [],
      otherSubscriptionsCount: 0,
      lastError: null,
      note,
      botCount: 0,
      bots: {},
    };
  }
}
