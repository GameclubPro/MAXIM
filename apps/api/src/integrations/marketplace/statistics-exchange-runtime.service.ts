import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '../../prisma/prisma-client';
import { getAppRole, roleRunsAction } from '../../runtime/app-role';
import { MarketplaceAccessService } from './marketplace-access.service';
import { type MarketplaceBindingRow } from './marketplace-state.service';
import { StatisticsExchangeStatisticsService } from './statistics-exchange-statistics.service';
import {
  StatisticsExchangeGrantsService,
  type StatisticsExchangeGrantRow,
} from './statistics-exchange-grants.service';

@Injectable()
export class StatisticsExchangeRuntimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StatisticsExchangeRuntimeService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private active: Promise<void> | null = null;
  private accessActive: Promise<void> | null = null;
  private remoteAccessActive: Promise<void> | null = null;
  private nextCleanupAt = 0;
  private stopping = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly statistics: StatisticsExchangeStatisticsService,
    private readonly grants: StatisticsExchangeGrantsService,
    @Optional() private readonly access?: MarketplaceAccessService,
  ) {}
  onModuleInit() {
    if (!this.enabled()) return;
    this.timer = setInterval(() => {
      // FLAG: Rights have an independent bounded lane; archive I/O cannot delay revocation checks.
      if (!this.accessActive)
        this.accessActive = this.refreshAccessBatch()
          .catch(() => this.logger.warn('EXCHANGE_ACCESS_UNAVAILABLE'))
          .finally(() => {
            this.accessActive = null;
          });
      if (!this.remoteAccessActive)
        this.remoteAccessActive = this.refreshRemoteAccessBatch()
          .catch(() => this.logger.warn('EXCHANGE_REMOTE_ACCESS_UNAVAILABLE'))
          .finally(() => {
            this.remoteAccessActive = null;
          });
      if (!this.active)
        this.active = this.tick()
          .catch(() => {
            this.logger.warn('EXCHANGE_RUNTIME_UNAVAILABLE');
          })
          .finally(() => {
            this.active = null;
          });
    }, 1000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([this.active, this.accessActive, this.remoteAccessActive]);
  }
  private enabled() {
    return (
      !this.stopping &&
      roleRunsAction(getAppRole()) &&
      !!this.config.get<string>('SVYAZKA_STATISTICS_EXPORT_TOKEN')
    );
  }
  async tick(): Promise<void> {
    if (!this.enabled()) return;
    // FLAG: Indexed interval expiry removes payloads once their earliest measurement ages out.
    if (this.nextCleanupAt <= Date.now()) {
      await this.prisma.$executeRaw`DELETE FROM statistics_exchange_generations WHERE id IN(
        SELECT id FROM statistics_exchange_generations WHERE retention_from<(date_trunc('day',now() AT TIME ZONE 'UTC')-interval '89 days') AT TIME ZONE 'UTC'
        ORDER BY retention_from,id LIMIT 100)`;
      this.nextCleanupAt = Date.now() + 60_000;
    }
    const lease = randomUUID();
    const rows = await this.prisma.$queryRaw<StatisticsExchangeGrantRow[]>`
      UPDATE statistics_exchange_grants SET lease_id=${lease}::uuid,lease_until=now()+interval '2 minutes'
      WHERE id IN(SELECT id FROM statistics_exchange_grants WHERE state='ACTIVE' AND next_pull_at<=now()
        AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_pull_at,id FOR UPDATE SKIP LOCKED LIMIT 4) RETURNING *`;
    const deadline = Date.now() + 10_000;
    await Promise.allSettled(rows.map((grant) => this.pullGrant(grant, lease, deadline)));
  }
  async refreshAccessBatch(): Promise<void> {
    if (!this.enabled() || !this.access) return;
    const deadline = Date.now() + 10_000;
    for (let page = 0; page < 5 && !this.stopping && Date.now() < deadline; page++) {
      // Claim only the four calls that start now, leaving unstarted work available next tick.
      const rows = await this.prisma.$queryRaw<MarketplaceBindingRow[]>`
        UPDATE marketplace_bindings SET next_access_at=now()+interval '1 minute'
        WHERE id IN(SELECT b.id FROM marketplace_bindings b
          WHERE b.statistics_consent=true AND b.state<>'REVOKED' AND b.next_access_at<=now()
            AND EXISTS(SELECT 1 FROM statistics_exchange_entities e JOIN statistics_exchange_grants g ON g.id=e.grant_id
              WHERE e.binding_id=b.id AND g.state='ACTIVE')
          ORDER BY b.next_access_at,b.id FOR UPDATE OF b SKIP LOCKED LIMIT 4) RETURNING *`;
      if (!rows.length) return;
      await Promise.allSettled(rows.map((row) => this.access!.refresh(row, true)));
    }
  }
  async refreshRemoteAccessBatch(): Promise<void> {
    if (!this.enabled()) return;
    const rows = await this.prisma.$queryRaw<Array<{ id: string; revision: bigint }>>`
      UPDATE statistics_exchange_grants SET next_remote_access_at=now()+interval '1 minute'
      WHERE id IN(SELECT id FROM statistics_exchange_grants WHERE state='ACTIVE' AND next_remote_access_at<=now()
        ORDER BY next_remote_access_at,id FOR UPDATE SKIP LOCKED LIMIT 4) RETURNING id,revision`;
    // The service CAS records errors only for the current check version; no stale lane error wins.
    await Promise.allSettled(
      rows.map((grant) => this.statistics.refreshRemoteAccess(grant.id, Number(grant.revision))),
    );
  }

  private async pullGrant(grant: StatisticsExchangeGrantRow, lease: string, deadline: number) {
    let success = false,
      nextCursor = grant.pull_cursor;
    try {
      const pending = await this.grants.recoverUnavailable(grant.id).catch(() => true);
      const result = await this.statistics.pull(grant.id, Number(grant.revision), {
        leaseId: lease,
        afterEntityKey: grant.pull_cursor,
        maxEntities: 3,
        deadline,
      });
      success = result.failures === 0;
      nextCursor = result.nextCursor ?? (pending ? '' : null);
    } catch {
      /* Persist fixed operational codes, never private data or remote responses. */
    } finally {
      await this.prune(grant.id, lease).catch(() => undefined);
      await this.prisma
        .$executeRaw`UPDATE statistics_exchange_grants SET lease_id=NULL,lease_until=NULL,
        pull_cursor=${nextCursor},next_pull_at=now()+CASE WHEN ${nextCursor !== null} THEN interval '1 second' WHEN ${success} THEN interval '5 minutes' ELSE interval '1 minute' END,
        last_pull_at=CASE WHEN ${success} THEN now() ELSE last_pull_at END,last_error=${success ? null : 'EXCHANGE_SYNC_UNAVAILABLE'}
        WHERE id=${grant.id}::uuid AND revision=${grant.revision} AND lease_id=${lease}::uuid`;
    }
  }
  async prune(id: string, lease: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const grants = await tx.$queryRaw<
        Array<{ prune_after_created_at: string | null; prune_after_id: string | null }>
      >`
        SELECT prune_after_created_at::text AS prune_after_created_at,prune_after_id FROM statistics_exchange_grants
        WHERE id=${id}::uuid AND lease_id=${lease}::uuid AND lease_until>now() FOR UPDATE`;
      if (!grants[0]) return;
      await tx.$executeRaw`UPDATE statistics_exchange_imports p SET rows=COALESCE((
        SELECT jsonb_agg(r.value ORDER BY r.ordinality) FROM jsonb_array_elements(p.rows) WITH ORDINALITY r(value,ordinality)
        WHERE (r.value->'data'->>'bucket')::timestamptz>=(date_trunc('day',now() AT TIME ZONE 'UTC')-interval '89 days') AT TIME ZONE 'UTC'
      ),'[]'::jsonb) WHERE p.grant_id=${id}::uuid`;
      const cursor = grants[0];
      // FLAG: Materialize a bounded indexed candidate page before testing whether newer data exists.
      const after =
        cursor.prune_after_created_at === null
          ? Prisma.sql`true`
          : Prisma.sql`(created_at,id)>(${cursor.prune_after_created_at}::timestamptz,${cursor.prune_after_id}::uuid)`;
      const candidates = await tx.$queryRaw<Array<{ id: string; created_at: string }>>(Prisma.sql`
        SELECT id,created_at::text AS created_at FROM statistics_exchange_generations WHERE grant_id=${id}::uuid
          AND created_at<now()-interval '1 day' AND ${after}
        ORDER BY created_at,id LIMIT 100`);
      if (candidates.length) {
        const ids = candidates.map((candidate) => candidate.id);
        await tx.$executeRaw`DELETE FROM statistics_exchange_generations old WHERE old.id=ANY(${ids}::uuid[])
          AND (EXISTS(SELECT 1 FROM statistics_exchange_grants g WHERE g.id=old.grant_id AND g.revision<>old.grant_revision)
            OR EXISTS(SELECT 1 FROM statistics_exchange_generations newer WHERE newer.grant_id=old.grant_id
              AND newer.grant_revision=old.grant_revision AND newer.entity_id=old.entity_id AND newer.kind=old.kind
              AND newer.origin=old.origin AND newer.producer_revision>old.producer_revision))`;
      }
      const last = candidates.length === 100 ? candidates.at(-1)! : null;
      await tx.$executeRaw`UPDATE statistics_exchange_grants SET prune_after_created_at=${last?.created_at ?? null}::timestamptz,
        prune_after_id=${last?.id ?? null}::uuid WHERE id=${id}::uuid AND lease_id=${lease}::uuid`;
    });
  }
}
