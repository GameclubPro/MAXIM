import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { MaxClientService } from '../max/max-client.service';
import { resolveRequiredWebhookUpdateTypes } from '../max/max-webhook-subscription.constants';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import { PublisherActionCredentialService } from './publisher-action-credential.service';
import {
  classifyPublisherFailure,
  PublisherDispatchHealthService,
} from './publisher-dispatch-health.service';
import { PublisherWebhookCredentialService } from './publisher-webhook-credential.service';
import { PublisherIdentityAttestationService } from './publisher-identity-attestation.service';

const DEFAULT_PUBLISHER_WEBHOOK_RECONCILE_INTERVAL_MS = 60_000;

@Injectable()
export class PublisherWebhookSubscriptionReconcilerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PublisherWebhookSubscriptionReconcilerService.name);
  private readonly publisherBotId: string;
  private readonly requiredUpdateTypes: readonly string[];
  private readonly replaceUpdateTypes: boolean;
  private readonly reconcileIntervalMs: number;
  private readonly headerSecretFingerprint: string;
  private appliedHeaderSecretFingerprint: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(
    private readonly maxClient: MaxClientService,
    credentials: PublisherActionCredentialService,
    webhookCredentials: PublisherWebhookCredentialService,
    private readonly identityAttestation: PublisherIdentityAttestationService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
    configService: ConfigService,
  ) {
    if (!roleRunsPublisher(getAppRole()) || process.env.APP_SERVICE_NAME !== 'api-publisher') {
      throw new Error('Publisher webhook reconciler loaded outside api-publisher');
    }
    this.publisherBotId = credentials.getBotId();
    credentials.getRequiredActionToken(this.publisherBotId);
    const webhookCredential = webhookCredentials.getConfiguredCredential();
    if (!webhookCredential || webhookCredential.botId !== this.publisherBotId) {
      throw new Error('Publisher webhook credentials are not configured for api-publisher');
    }
    this.headerSecretFingerprint = createHash('sha256')
      .update(webhookCredential.headerSecrets[0] ?? '')
      .digest('hex');
    const extendedLifecycleMode = configService.get<string>(
      'MAX_EXTENDED_WEBHOOK_LIFECYCLE_MODE',
      'shadow',
    );
    this.requiredUpdateTypes = resolveRequiredWebhookUpdateTypes(extendedLifecycleMode);
    this.replaceUpdateTypes = extendedLifecycleMode === 'off';
    this.reconcileIntervalMs = Math.max(
      10_000,
      configService.get<number>(
        'MAX_WEBHOOK_RECONCILE_INTERVAL_MS',
        DEFAULT_PUBLISHER_WEBHOOK_RECONCILE_INTERVAL_MS,
      ),
    );
  }

  async onModuleInit(): Promise<void> {
    await this.reconcile('startup');
    this.timer = setInterval(() => {
      void this.reconcile('scheduled');
    }, this.reconcileIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async reconcile(reason: 'startup' | 'scheduled'): Promise<void> {
    if (this.inFlight) {
      return;
    }
    this.inFlight = true;
    const reconcileStartedAt = new Date();
    try {
      await this.identityAttestation.assertAttested();
      const target = this.maxClient.getConfiguredWebhookSubscriptionTarget(this.publisherBotId);
      if (!target.url) {
        throw new Error('Publisher webhook URL is not configured');
      }
      const existing = await this.maxClient.listWebhookSubscriptions({
        botId: this.publisherBotId,
        trafficClass: 'background',
        sourceTag: 'publisher_webhook_reconcile',
      });
      const current = existing.find((subscription) =>
        this.maxClient.matchesConfiguredWebhookUrl(subscription.url, this.publisherBotId),
      );
      const missing = this.requiredUpdateTypes.filter(
        (updateType) => !current?.updateTypes.includes(updateType),
      );
      const extra = (current?.updateTypes ?? []).filter(
        (updateType) => !this.requiredUpdateTypes.includes(updateType),
      );
      const shouldRefreshHeaderSecret =
        this.appliedHeaderSecretFingerprint !== this.headerSecretFingerprint;
      if (
        !current ||
        missing.length > 0 ||
        (this.replaceUpdateTypes && extra.length > 0) ||
        shouldRefreshHeaderSecret
      ) {
        await this.maxClient.ensureWebhookSubscription([...this.requiredUpdateTypes], {
          botId: this.publisherBotId,
          trafficClass: 'background',
          sourceTag: 'publisher_webhook_reconcile',
          ...(shouldRefreshHeaderSecret ? { forceUpsert: true } : {}),
          ...(this.replaceUpdateTypes ? { replaceUpdateTypes: true } : {}),
        });
      }

      const established = await this.maxClient.listWebhookSubscriptions({
        botId: this.publisherBotId,
        trafficClass: 'background',
        sourceTag: 'publisher_webhook_reconcile',
      });
      const establishedCurrent = established.find((subscription) =>
        this.maxClient.matchesConfiguredWebhookUrl(subscription.url, this.publisherBotId),
      );
      const establishedMissing = this.requiredUpdateTypes.filter(
        (updateType) => !establishedCurrent?.updateTypes.includes(updateType),
      );
      if (!establishedCurrent || establishedMissing.length > 0) {
        throw new Error('Publisher webhook subscription could not be established');
      }

      // FLAG: Establish the current target before removing an obsolete publisher-owned target.
      for (const subscription of established) {
        if (
          this.maxClient.matchesConfiguredWebhookUrl(subscription.url, this.publisherBotId) ||
          !this.isPublisherOwnedWebhookUrl(subscription.url)
        ) {
          continue;
        }
        await this.maxClient.deleteWebhookSubscription(subscription.url, {
          botId: this.publisherBotId,
          trafficClass: 'background',
          sourceTag: 'publisher_webhook_reconcile',
        });
      }

      const confirmed = await this.maxClient.listWebhookSubscriptions({
        botId: this.publisherBotId,
        trafficClass: 'background',
        sourceTag: 'publisher_webhook_reconcile',
      });
      const confirmedCurrent = confirmed.find((subscription) =>
        this.maxClient.matchesConfiguredWebhookUrl(subscription.url, this.publisherBotId),
      );
      const confirmedMissing = this.requiredUpdateTypes.filter(
        (updateType) => !confirmedCurrent?.updateTypes.includes(updateType),
      );
      if (!confirmedCurrent || confirmedMissing.length > 0) {
        throw new Error('Publisher webhook subscription could not be confirmed');
      }
      this.appliedHeaderSecretFingerprint = this.headerSecretFingerprint;
      await this.dispatchHealth.recordAuthenticatedSuccess(reconcileStartedAt);
    } catch (error: unknown) {
      if (classifyPublisherFailure(error) === 'global_paused') {
        await this.dispatchHealth.recordGlobalAuthorizationFailure(new Date());
      }
      this.logger.warn(
        {
          reason,
          errorType: error instanceof Error ? error.name : 'unknown',
        },
        'Failed to reconcile publisher webhook subscription',
      );
    } finally {
      this.inFlight = false;
    }
  }

  private isPublisherOwnedWebhookUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname.split('/').filter(Boolean);
      return (
        segments.length >= 5 &&
        segments[0] === 'api' &&
        segments[1] === 'webhook' &&
        segments[2] === 'max' &&
        decodeURIComponent(segments[3] ?? '') === this.publisherBotId &&
        Boolean(segments[4])
      );
    } catch {
      return false;
    }
  }
}
