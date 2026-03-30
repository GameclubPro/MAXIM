import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  webhookSubscriptionSnapshotSchema,
  type WebhookSubscriptionSnapshot,
} from '@maxim/contracts';
import Redis from 'ioredis';
import { MAX_REQUIRED_WEBHOOK_UPDATE_TYPES } from '../max/max-webhook-subscription.constants';

const WEBHOOK_SUBSCRIPTION_STATUS_KEY = 'system:webhook-subscription:status:v1';
const WEBHOOK_SUBSCRIPTION_SYNC_STATE_KEY = 'system:webhook-subscription:sync-state:v1';
const LOCAL_SNAPSHOT_CACHE_TTL_MS = 2_000;

export type WebhookSubscriptionSyncState = {
  configuredUrl: string | null;
  headerSecretFingerprint: string | null;
  updatedAt: string;
};

@Injectable()
export class WebhookSubscriptionStatusService implements OnModuleDestroy {
  private readonly logger = new Logger(WebhookSubscriptionStatusService.name);
  private readonly redis: Redis;
  private cachedSnapshot: WebhookSubscriptionSnapshot | null = null;
  private cachedAtMs = 0;

  constructor(configService: ConfigService) {
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }

  async getSnapshot(): Promise<WebhookSubscriptionSnapshot> {
    if (this.cachedSnapshot && Date.now() - this.cachedAtMs <= LOCAL_SNAPSHOT_CACHE_TTL_MS) {
      return this.cachedSnapshot;
    }

    const raw = await this.redis.get(WEBHOOK_SUBSCRIPTION_STATUS_KEY);
    if (!raw) {
      const fallback = this.createPendingSnapshot();
      this.cacheSnapshot(fallback);
      return fallback;
    }

    try {
      const parsed = webhookSubscriptionSnapshotSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        const fallback = this.createPendingSnapshot();
        this.cacheSnapshot(fallback);
        return fallback;
      }

      this.cacheSnapshot(parsed.data);
      return parsed.data;
    } catch (error: unknown) {
      this.logger.warn(
        {
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to parse cached webhook subscription snapshot',
      );
      const fallback = this.createPendingSnapshot();
      this.cacheSnapshot(fallback);
      return fallback;
    }
  }

  async writeSnapshot(snapshot: WebhookSubscriptionSnapshot): Promise<void> {
    this.cacheSnapshot(snapshot);
    await this.redis.set(WEBHOOK_SUBSCRIPTION_STATUS_KEY, JSON.stringify(snapshot));
  }

  async getSyncState(): Promise<WebhookSubscriptionSyncState | null> {
    try {
      const raw = await this.redis.get(WEBHOOK_SUBSCRIPTION_SYNC_STATE_KEY);
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw) as Partial<WebhookSubscriptionSyncState>;
      return {
        configuredUrl:
          typeof parsed.configuredUrl === 'string' && parsed.configuredUrl.trim().length > 0
            ? parsed.configuredUrl
            : null,
        headerSecretFingerprint:
          typeof parsed.headerSecretFingerprint === 'string' &&
          parsed.headerSecretFingerprint.trim().length > 0
            ? parsed.headerSecretFingerprint
            : null,
        updatedAt:
          typeof parsed.updatedAt === 'string' && parsed.updatedAt.trim().length > 0
            ? parsed.updatedAt
            : new Date(0).toISOString(),
      };
    } catch (error: unknown) {
      this.logger.warn(
        {
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to parse cached webhook subscription sync state',
      );
      return null;
    }
  }

  async writeSyncState(state: WebhookSubscriptionSyncState): Promise<void> {
    await this.redis.set(WEBHOOK_SUBSCRIPTION_SYNC_STATE_KEY, JSON.stringify(state));
  }

  createPendingSnapshot(
    note = 'Первая проверка webhook subscription ещё не завершилась.',
  ): WebhookSubscriptionSnapshot {
    return {
      status: 'warning',
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

  private cacheSnapshot(snapshot: WebhookSubscriptionSnapshot) {
    this.cachedSnapshot = snapshot;
    this.cachedAtMs = Date.now();
  }
}
