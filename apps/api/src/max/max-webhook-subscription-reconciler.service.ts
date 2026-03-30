import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WebhookSubscriptionSnapshot } from '@maxim/contracts';
import { createHash } from 'node:crypto';
import { getAppRole, roleRunsIngress } from '../runtime/app-role';
import { WebhookSubscriptionStatusService } from '../system/webhook-subscription-status.service';
import { MaxClientService } from './max-client.service';
import { MAX_REQUIRED_WEBHOOK_UPDATE_TYPES } from './max-webhook-subscription.constants';

const DEFAULT_RECONCILE_INTERVAL_MS = 10 * 60 * 1_000;
const REQUIRED_WEBHOOK_UPDATE_TYPES_SET = new Set<string>(MAX_REQUIRED_WEBHOOK_UPDATE_TYPES);

@Injectable()
export class MaxWebhookSubscriptionReconcilerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaxWebhookSubscriptionReconcilerService.name);
  private readonly enabled = roleRunsIngress(getAppRole());
  private readonly reconcileIntervalMs: number;
  private readonly webhookHeaderSecretFingerprint: string | null;
  private readonly allowPreviousWebhookHeaderSecret: boolean;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(
    private readonly maxClient: MaxClientService,
    private readonly webhookSubscriptionStatusService: WebhookSubscriptionStatusService,
    configService: ConfigService,
  ) {
    this.reconcileIntervalMs = configService.get<number>(
      'MAX_WEBHOOK_RECONCILE_INTERVAL_MS',
      DEFAULT_RECONCILE_INTERVAL_MS,
    );
    this.webhookHeaderSecretFingerprint = this.computeSecretFingerprint(
      configService.get<string>('MAX_WEBHOOK_HEADER_SECRET'),
    );
    this.allowPreviousWebhookHeaderSecret =
      typeof configService.get<string>('MAX_WEBHOOK_HEADER_SECRET_PREVIOUS') === 'string' &&
      configService.get<string>('MAX_WEBHOOK_HEADER_SECRET_PREVIOUS')!.trim().length > 0;
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      await this.webhookSubscriptionStatusService.writeSnapshot(
        this.createDisabledSnapshot('Webhook reconcile отключён на этом app role.'),
      );
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
      const target = this.maxClient.getConfiguredWebhookSubscriptionTarget();
      if (!target.url) {
        await this.webhookSubscriptionStatusService.writeSnapshot(
          this.createDisabledSnapshot('Webhook URL не сконфигурирован.'),
        );
        return;
      }

      const existing = await this.maxClient.listWebhookSubscriptions({
        trafficClass: 'background',
      });
      const syncState = await this.webhookSubscriptionStatusService.getSyncState();
      const current = existing.find((item) => this.maxClient.matchesConfiguredWebhookUrl(item.url));
      const actualUpdateTypes = [...(current?.updateTypes ?? [])].sort();
      const missingUpdateTypes = MAX_REQUIRED_WEBHOOK_UPDATE_TYPES.filter(
        (type) => !actualUpdateTypes.includes(type),
      );
      const extraUpdateTypes = actualUpdateTypes.filter(
        (type) => !REQUIRED_WEBHOOK_UPDATE_TYPES_SET.has(type),
      );
      const otherSubscriptionsCount = existing.filter(
        (item) => !this.maxClient.matchesConfiguredWebhookUrl(item.url),
      ).length;
      const previousConfiguredUrl =
        syncState?.configuredUrl && syncState.configuredUrl !== target.url
          ? syncState.configuredUrl
          : null;
      const shouldRotateWebhookSecret =
        Boolean(current) &&
        this.allowPreviousWebhookHeaderSecret &&
        (!syncState?.headerSecretFingerprint ||
          syncState.headerSecretFingerprint !== this.webhookHeaderSecretFingerprint);

      let reconciledAt: string | null = null;
      let effectiveOtherSubscriptionsCount = otherSubscriptionsCount;
      if (shouldRotateWebhookSecret) {
        await this.maxClient.deleteWebhookSubscription(target.url, {
          trafficClass: 'background',
        });
        await this.maxClient.ensureWebhookSubscription([...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES], {
          trafficClass: 'background',
        });
        reconciledAt = new Date().toISOString();
      } else if (!current || missingUpdateTypes.length > 0) {
        await this.maxClient.ensureWebhookSubscription([...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES], {
          trafficClass: 'background',
        });
        reconciledAt = new Date().toISOString();
      }

      if (previousConfiguredUrl) {
        const hasPreviousConfiguredUrl = existing.some(
          (item) => item.url === previousConfiguredUrl,
        );
        if (hasPreviousConfiguredUrl) {
          await this.maxClient.deleteWebhookSubscription(previousConfiguredUrl, {
            trafficClass: 'background',
          });
          reconciledAt = reconciledAt ?? new Date().toISOString();
          effectiveOtherSubscriptionsCount = Math.max(0, effectiveOtherSubscriptionsCount - 1);
        }
      }

      const refreshedCurrent =
        !current || missingUpdateTypes.length > 0 || shouldRotateWebhookSecret
          ? {
              url: target.url,
              updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES].sort(),
            }
          : current;
      const refreshedActualUpdateTypes = [...refreshedCurrent.updateTypes].sort();

      await this.webhookSubscriptionStatusService.writeSyncState({
        configuredUrl: target.url,
        headerSecretFingerprint: this.webhookHeaderSecretFingerprint,
        updatedAt: new Date().toISOString(),
      });
      await this.webhookSubscriptionStatusService.writeSnapshot({
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
        }),
        configured: true,
        url: target.maskedUrl,
        checkedAt: new Date().toISOString(),
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
          reason === 'startup'
            ? 'Webhook coverage проверена при старте ingress.'
            : 'Webhook coverage поддерживается фоновым reconcile.',
      });
    } catch (error: unknown) {
      const previous = await this.webhookSubscriptionStatusService.getSnapshot();
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

  private resolveStatus(input: {
    configured: boolean;
    hasCurrentSubscription: boolean;
    missingUpdateTypes: readonly string[];
    extraUpdateTypes: readonly string[];
    otherSubscriptionsCount: number;
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

    return 'healthy';
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
    };
  }

  private computeSecretFingerprint(secret: string | undefined): string | null {
    const normalized = typeof secret === 'string' ? secret.trim() : '';
    if (!normalized) {
      return null;
    }

    return createHash('sha256').update(normalized).digest('hex');
  }
}
