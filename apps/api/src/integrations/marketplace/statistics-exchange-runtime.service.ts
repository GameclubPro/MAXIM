import { centralEnabled } from '../../statistics/stats-common';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '../../prisma/prisma-client';
import { getAppRole, roleRunsAction } from '../../runtime/app-role';
import { classifyExchangeFailure, exchangeRetryDelay } from './statistics-exchange-errors';
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
      // FLAG: Central rights refresh consumes expiring demand, never a fleet sweep.
      if (!this.accessActive)
        this.accessActive = this.refreshAccessBatch()
          .catch(() => this.logger.warn('EXCHANGE_ACCESS_UNAVAILABLE'))
          .finally(() => {
            this.accessActive = null;
          });
      if (!centralEnabled(this.config) && !this.remoteAccessActive)
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
      !!this.config.get<string>(
        centralEnabled(this.config) ? 'SVYAZKA_ANALYTICS_TOKEN' : 'SVYAZKA_STATISTICS_EXPORT_TOKEN',
      )
    );
  }
  async tick(): Promise<void> {
    if (!this.enabled()) return;
    const central = centralEnabled(this.config);
    // FLAG: Central history retains cleanup, but no idle grant may schedule MAX work.
    if (this.nextCleanupAt <= Date.now()) {
      if (!central) {
        await this.prisma.$executeRaw`DELETE FROM statistics_exchange_generations WHERE id IN(
        SELECT id FROM statistics_exchange_generations WHERE retention_from<(date_trunc('day',now() AT TIME ZONE 'UTC')-interval '89 days') AT TIME ZONE 'UTC'
        ORDER BY retention_from,id LIMIT 100)`;
        await this.prisma.$executeRaw`DELETE FROM statistics_exchange_downloads WHERE id IN(
        SELECT id FROM statistics_exchange_downloads WHERE expires_at<=now() ORDER BY expires_at,id LIMIT 100 FOR UPDATE SKIP LOCKED)`;
        await this.prisma.$executeRaw`DELETE FROM statistics_exchange_v3_generations WHERE id IN(
        SELECT id FROM statistics_exchange_v3_generations WHERE retention_from<(date_trunc('day',now() AT TIME ZONE 'UTC')-interval '89 days') AT TIME ZONE 'UTC'
        ORDER BY retention_from,id LIMIT 100 FOR UPDATE SKIP LOCKED)`;
      }
      await this.prisma
        .$executeRaw`DELETE FROM statistics_exchange_membership_snapshots WHERE id IN(
        SELECT id FROM statistics_exchange_membership_snapshots WHERE expires_at<=now() ORDER BY expires_at,id LIMIT 100 FOR UPDATE SKIP LOCKED)`;
      this.nextCleanupAt = Date.now() + 60_000;
    }
    if (central) return;
    const lease = randomUUID();
    const rows = await this.prisma.$queryRaw<StatisticsExchangeGrantRow[]>`
      UPDATE statistics_exchange_grants SET lease_id=${lease}::uuid,lease_until=now()+interval '2 minutes',last_attempt_at=now()
      WHERE id IN(SELECT id FROM statistics_exchange_grants WHERE state='ACTIVE' AND next_pull_at<=now()
        AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_pull_at,id FOR UPDATE SKIP LOCKED LIMIT 4) RETURNING *`;
    const deadline = Date.now() + 10_000;
    await Promise.allSettled(rows.map((grant) => this.pullGrant(grant, lease, deadline)));
  }
  async refreshAccessBatch(): Promise<void> {
    if (!this.enabled()) return;
    const deadline = Date.now() + 10_000;
    if (centralEnabled(this.config)) {
      for (let count = 0; count < 4 && !this.stopping && Date.now() < deadline; count++) {
        try {
          if (!(await this.grants.refreshRequestedAccess())) return;
        } catch {
          this.logger.warn('EXCHANGE_ACCESS_UNAVAILABLE');
          return;
        }
      }
      return;
    }
    if (!this.access) return;
    for (let attempt = 0; attempt < 20 && !this.stopping && Date.now() < deadline; attempt++) {
      // FLAG: Claim only the next admitted check. A slow/failed check or shutdown
      // must not postpone unstarted bindings; MAX admission remains sequential.
      const [row] = await this.prisma.$queryRaw<MarketplaceBindingRow[]>`
        UPDATE marketplace_bindings SET next_access_at=now()+interval '1 minute'
        WHERE id IN(SELECT b.id FROM marketplace_bindings b
          WHERE b.statistics_consent=true AND b.state<>'REVOKED' AND b.next_access_at<=now()
            AND EXISTS(SELECT 1 FROM statistics_exchange_entities e JOIN statistics_exchange_grants g ON g.id=e.grant_id
              WHERE e.binding_id=b.id AND g.state='ACTIVE')
          ORDER BY b.next_access_at,b.id FOR UPDATE OF b SKIP LOCKED LIMIT 1) RETURNING *`;
      if (!row) return;
      await this.access.refresh(row, true);
    }
  }
  async refreshRemoteAccessBatch(): Promise<void> {
    if (!this.enabled() || centralEnabled(this.config)) return;
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
    const central = centralEnabled(this.config);
    let nextCursor = grant.pull_cursor,
      nextDelayMs = 60000,
      completedEntities = 0;
    let phase = 'RECOVERY';
    let error: { code: string; phase: string; entityKey: string | null } | null = null;
    try {
      if (!central) {
        phase = 'RIGHTS';
        const result = await this.statistics.pull(grant.id, Number(grant.revision), {
          leaseId: lease,
          afterEntityKey: grant.pull_cursor,
          maxEntities: 3,
          deadline,
        });
        completedEntities = result.completedEntities;
        nextCursor = result.nextCursor;
        nextDelayMs = result.nextDelayMs;
        error = result.lastError;
      }
      // FLAG: Recover missing bindings after active-entity progress; a denied recovery never blocks that page lane.
      if (Date.now() < deadline - 1000) {
        phase = 'RECOVERY';
        try {
          const recoveryPending = await this.grants.recoverUnavailable(grant.id);
          if (recoveryPending) {
            // FLAG: One missing binding per bounded visit; large rosters must not wait a minute per entity.
            nextDelayMs = Math.min(nextDelayMs, central ? 1000 : 60000);
            error ??= { code: 'EXCHANGE_ACCESS_PENDING', phase: 'RECOVERY', entityKey: null };
          }
        } catch (caught) {
          const failure = classifyExchangeFailure(caught);
          error ??= { code: failure.code, phase: 'RECOVERY', entityKey: null };
          nextDelayMs = Math.min(
            nextDelayMs,
            exchangeRetryDelay(failure, (grant.failure_count ?? 0) + 1),
          );
        }
      }
    } catch (caught) {
      const failure = classifyExchangeFailure(caught);
      error = { code: failure.code, phase, entityKey: null };
      nextDelayMs = exchangeRetryDelay(failure, (grant.failure_count ?? 0) + 1);
    } finally {
      if (!central) await this.prune(grant.id, lease).catch(() => undefined);
      // FLAG: Page progress/READY are not a completed import. Persist only fixed codes and exact entity keys.
      await this.prisma
        .$executeRaw`UPDATE statistics_exchange_grants SET lease_id=NULL,lease_until=NULL,
        pull_cursor=${nextCursor},next_pull_at=now()+${nextDelayMs}*interval '1 millisecond',
        last_pull_at=CASE WHEN ${completedEntities > 0} THEN now() ELSE last_pull_at END,
        failure_count=CASE WHEN ${error !== null} THEN LEAST(failure_count+1,100) ELSE 0 END,
        last_error=${error?.code ?? null},last_error_phase=${error?.phase ?? null},last_error_entity=${error?.entityKey ?? null}
        WHERE id=${grant.id}::uuid AND revision=${grant.revision} AND lease_id=${lease}::uuid AND lease_until>now()`;
    }
  }

  async prune(id: string, lease: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const grants = await tx.$queryRaw<
        Array<{
          prune_after_created_at: string | null;
          prune_after_id: string | null;
          revision: bigint;
          imports_due: boolean;
        }>
      >`
        SELECT prune_after_created_at::text AS prune_after_created_at,prune_after_id,revision,(next_import_prune_at<=now()) AS imports_due FROM statistics_exchange_grants
        WHERE id=${id}::uuid AND lease_id=${lease}::uuid AND lease_until>now() FOR UPDATE`;
      if (!grants[0]) return;
      if (grants[0].imports_due) {
        const cutoff = new Date();
        cutoff.setUTCHours(0, 0, 0, 0);
        cutoff.setUTCDate(cutoff.getUTCDate() - 89);
        // FLAG: The retention index bounds both candidate work and JSON parsing to fifty stale projections.
        const imports = await tx.$queryRaw<Array<{ entity_id: string; kind: string }>>`
          SELECT entity_id,kind FROM statistics_exchange_imports WHERE grant_id=${id}::uuid
            AND grant_revision=${grants[0].revision} AND retention_checked_from<${cutoff}
          ORDER BY retention_checked_from,entity_id,kind LIMIT 50 FOR UPDATE SKIP LOCKED`;
        if (imports.length) {
          const candidates = JSON.stringify(imports);
          await tx.$executeRaw`UPDATE statistics_exchange_imports p SET rows=COALESCE((
            SELECT jsonb_agg(r.value ORDER BY r.ordinality) FROM jsonb_array_elements(p.rows) WITH ORDINALITY r(value,ordinality)
            WHERE (r.value->'data'->>'bucket')::timestamptz>=${cutoff}
          ),'[]'::jsonb),retention_checked_from=${cutoff}
          FROM jsonb_to_recordset(${candidates}::jsonb) c(entity_id text,kind text)
          WHERE p.grant_id=${id}::uuid AND p.grant_revision=${grants[0].revision} AND p.entity_id=c.entity_id AND p.kind=c.kind
            AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.rows) r WHERE (r->'data'->>'bucket')::timestamptz<${cutoff})`;
          // Updating only the daily marker preserves the unchanged JSON/TOAST value.
          await tx.$executeRaw`UPDATE statistics_exchange_imports p SET retention_checked_from=${cutoff}
            FROM jsonb_to_recordset(${candidates}::jsonb) c(entity_id text,kind text)
            WHERE p.grant_id=${id}::uuid AND p.grant_revision=${grants[0].revision} AND p.entity_id=c.entity_id AND p.kind=c.kind
              AND p.retention_checked_from<${cutoff}`;
        }
        await tx.$executeRaw`UPDATE statistics_exchange_grants SET next_import_prune_at=CASE WHEN ${imports.length === 50}
          THEN now()+interval '1 second' ELSE (date_trunc('day',now() AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC' END WHERE id=${id}::uuid`;
      }
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
        prune_after_id=${last?.id ?? null}::uuid WHERE id=${id}::uuid AND lease_id=${lease}::uuid
          AND (prune_after_created_at IS DISTINCT FROM ${last?.created_at ?? null}::timestamptz
            OR prune_after_id IS DISTINCT FROM ${last?.id ?? null}::uuid)`;
    });
  }
}
