import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WebhookSubscriptionSnapshot } from '@maxim/contracts';
import { getAppRole, roleRunsHttp } from '../runtime/app-role';
import { WebhookSubscriptionStatusService } from '../system/webhook-subscription-status.service';
import { MaxClientService } from './max-client.service';
import { MAX_REQUIRED_WEBHOOK_UPDATE_TYPES } from './max-webhook-subscription.constants';

const DEFAULT_RECONCILE_INTERVAL_MS = 10 * 60 * 1_000;
const REQUIRED_WEBHOOK_UPDATE_TYPES_SET = new Set<string>(MAX_REQUIRED_WEBHOOK_UPDATE_TYPES);

@Injectable()
export class MaxWebhookSubscriptionReconcilerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaxWebhookSubscriptionReconcilerService.name);
  private readonly enabled = roleRunsHttp(getAppRole());
  private readonly reconcileIntervalMs: number;
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

      let reconciledAt: string | null = null;
      if (!current || missingUpdateTypes.length > 0) {
        await this.maxClient.ensureWebhookSubscription([...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES], {
          trafficClass: 'background',
        });
        reconciledAt = new Date().toISOString();
      }

      const refreshedCurrent =
        !current || missingUpdateTypes.length > 0
          ? {
              url: target.url,
              updateTypes: Array.from(
                new Set([...(current?.updateTypes ?? []), ...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES]),
              ).sort(),
            }
          : current;
      const refreshedActualUpdateTypes = [...refreshedCurrent.updateTypes].sort();

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
          otherSubscriptionsCount,
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
        otherSubscriptionsCount,
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
}
