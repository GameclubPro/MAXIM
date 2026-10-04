import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { getAppRole, roleRunsAction, roleRunsPublisher } from '../../runtime/app-role';
import { PrismaService } from '../../prisma/prisma.service';
import { MarketplaceAccessService } from './marketplace-access.service';
import { MarketplaceCollectorService } from './marketplace-collector.service';
import { MarketplaceProfileService } from './marketplace-profile.service';
import { MarketplaceStateService, type MarketplaceBindingRow } from './marketplace-state.service';
import { PublisherIdentityAttestationService } from '../../publisher/publisher-identity-attestation.service';

@Injectable()
export class MarketplaceRuntimeService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private stopping = false;
  private active: Promise<void> | null = null;
  private readonly logger = new Logger(MarketplaceRuntimeService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly state: MarketplaceStateService,
    private readonly access: MarketplaceAccessService,
    private readonly collector: MarketplaceCollectorService,
    private readonly profile: MarketplaceProfileService,
    @Optional() private readonly publisherIdentity?: PublisherIdentityAttestationService,
  ) {}
  onModuleInit() {
    if (
      (!roleRunsAction(getAppRole()) && !roleRunsPublisher(getAppRole())) ||
      !this.state.enabled()
    )
      return;
    this.timer = setInterval(() => {
      if (!this.active)
        this.active = this.tick().finally(() => {
          this.active = null;
        });
    }, 30_000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
  async tick(): Promise<void> {
    if (
      this.busy ||
      this.stopping ||
      !this.state.enabled() ||
      (!roleRunsAction(getAppRole()) && !roleRunsPublisher(getAppRole()))
    )
      return;
    this.busy = true;
    try {
      const profile = roleRunsPublisher(getAppRole()) ? 'publisher' : 'moderation';
      if (profile === 'publisher') {
        if (!this.publisherIdentity || process.env.APP_SERVICE_NAME !== 'api-publisher') return;
        await this.publisherIdentity.assertAttested();
      }
      const accessRows = await this.prisma.$queryRaw<
        MarketplaceBindingRow[]
      >`UPDATE marketplace_bindings SET next_access_at=now()+interval '1 minute' WHERE id IN (SELECT id FROM marketplace_bindings WHERE profile=${profile} AND statistics_consent=true AND state<>'REVOKED' AND next_access_at<=now() ORDER BY next_access_at,id FOR UPDATE SKIP LOCKED LIMIT 5) RETURNING *`;
      for (const row of accessRows) {
        if (this.stopping) return;
        await this.access.refresh(row);
      }
      const linkRows = await this.prisma.$queryRaw<
        MarketplaceBindingRow[]
      >`SELECT * FROM marketplace_bindings WHERE profile=${profile} AND append_enabled=true AND state='ACTIVE' AND valid_until>now()
        AND (public_verified_until IS NULL OR public_verified_until<now()+interval '2 minutes') ORDER BY public_verified_until NULLS FIRST,id LIMIT 5`;
      for (const row of linkRows) {
        if (this.stopping) return;
        await this.profile.relay(row).catch(() => undefined);
      }
      if (!this.stopping) await this.collector.tick(profile);
      if (!this.stopping && roleRunsAction(getAppRole())) await this.prune();
    } catch {
      this.logger.warn(
        { code: 'MARKETPLACE_SYNC_UNAVAILABLE' },
        'Marketplace synchronization deferred',
      );
    } finally {
      this.busy = false;
    }
  }
  private async prune() {
    await this.prisma
      .$executeRaw`DELETE FROM marketplace_statistics_generations WHERE id IN(SELECT g.id FROM marketplace_statistics_generations g
      WHERE g.created_at<now()-interval '1 day' AND NOT EXISTS(SELECT 1 FROM marketplace_bindings b WHERE b.generation_id=g.id) ORDER BY g.created_at,g.id LIMIT 100)`;
    await this.prisma
      .$executeRaw`DELETE FROM marketplace_post_samples WHERE (binding_id,message_id) IN(SELECT binding_id,message_id FROM marketplace_post_samples
      WHERE published_at<(date_trunc('day',now() AT TIME ZONE 'UTC')-interval '89 days') AT TIME ZONE 'UTC' ORDER BY published_at,binding_id,message_id LIMIT 500)`;
    await this.prisma
      .$executeRaw`DELETE FROM marketplace_audience_observations WHERE (binding_id,bucket) IN(SELECT binding_id,bucket FROM marketplace_audience_observations
      WHERE bucket<(date_trunc('day',now() AT TIME ZONE 'UTC')-interval '89 days') AT TIME ZONE 'UTC' ORDER BY bucket,binding_id LIMIT 500)`;
  }
}
