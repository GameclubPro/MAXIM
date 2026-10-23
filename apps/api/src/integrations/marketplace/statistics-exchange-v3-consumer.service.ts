import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import {
  exchangeEntityKey,
  exchangeV3AccessPageSchema,
  exchangeV3CapabilitiesSchema,
  exchangeV3ContentCanonical,
  exchangeV3ContentSchema,
  exchangeV3GrantHeaderSchema,
  exchangeV3HeadSchema,
  validateExchangeV3Head,
  validateExchangeV3StatisticsPage,
  type ExchangeManifest,
  type ExchangeMeasurement,
  type ExchangeV3AccessEntity,
  type ExchangeV3GrantHeader,
  type ExchangeV3Head,
  type ExchangeV3Content,
} from '@maxim/contracts';
import { marketplaceBindingMetadataSchema } from '@maxim/contracts/marketplace-integration';
import { Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { marketplaceLocalGrantSql } from './marketplace-state.service';
import { StatisticsExchangeGrantsService } from './statistics-exchange-grants.service';
import {
  StatisticsExchangeDownloadsService,
  type ExchangeDownload,
  type ExchangeDownloadScope,
} from './statistics-exchange-downloads.service';
import {
  classifyExchangeFailure,
  exchangeRetryDelay,
  ExchangeResponseError,
} from './statistics-exchange-errors';
import { canonicalExchangeMeasurements } from './statistics-exchange-values';
import { exchangeV3LegacyManifest } from './statistics-exchange-v3-values';

export type ExchangeV3Remote = (path: string, deadline?: number) => Promise<unknown>;
export type ExchangePullOptions = {
  leaseId: string;
  afterEntityKey: string | null;
  maxEntities: number;
  deadline: number;
};
export type ExchangePullResult = {
  nextCursor: string | null;
  failures: number;
  pending: boolean;
  completedEntities: number;
  nextDelayMs: number;
  lastError: { code: string; phase: string; entityKey: string; retryAfterMs: number | null } | null;
};
export type ExchangeV3Activate = (
  manifest: ExchangeManifest,
  rows: ExchangeMeasurement[],
  bindingId: string,
  leaseId?: string,
  download?: ExchangeDownload,
  content?: ExchangeV3Content,
  remoteBindingRevision?: number,
) => Promise<boolean>;
type AccessScan = {
  actor_user_id: string;
  remote_access_version: bigint;
  remote_access_cursor: string | null;
  remote_access_revision: bigint | null;
  remote_access_sweep_id: string | null;
  remote_access_sweep_started_at: Date | null;
};

@Injectable()
export class StatisticsExchangeV3ConsumerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly grants: StatisticsExchangeGrantsService,
    private readonly downloads: StatisticsExchangeDownloadsService,
  ) {}

  async supported(id: string, remote: ExchangeV3Remote, deadline?: number): Promise<boolean> {
    if (this.config.get<boolean>('STATISTICS_EXCHANGE_V3_ENABLED') !== true) return false;
    const cached = (
      await this.prisma.$queryRaw<
        Array<{ remote_protocol: number | null }>
      >`SELECT remote_protocol FROM statistics_exchange_grants WHERE id=${id}::uuid AND remote_protocol_checked_at>now()-interval '5 minutes'`
    )[0];
    if (cached?.remote_protocol) return cached.remote_protocol === 3;
    let protocol: number;
    try {
      const raw = await remote('/capabilities', deadline);
      const capabilities = exchangeV3CapabilitiesSchema.parse(raw);
      protocol = capabilities.supportedVersions.includes(3) ? 3 : 2;
    } catch (error) {
      if (error instanceof ExchangeResponseError && (error.status === 404 || error.status === 405))
        protocol = 2;
      else throw error;
    }
    await this.prisma
      .$executeRaw`UPDATE statistics_exchange_grants SET remote_protocol=${protocol},remote_protocol_checked_at=now() WHERE id=${id}::uuid`;
    return protocol === 3;
  }

  private async reserve(id: string, revision: number): Promise<AccessScan> {
    const scan = (
      await this.prisma.$queryRaw<
        AccessScan[]
      >`UPDATE statistics_exchange_grants SET remote_access_version=remote_access_version+1,last_remote_access_attempt_at=now() WHERE id=${id}::uuid AND revision=${revision} AND state='ACTIVE' RETURNING actor_user_id,remote_access_version,remote_access_cursor,remote_access_revision,remote_access_sweep_id,remote_access_sweep_started_at`
    )[0];
    if (!scan) throw new ConflictException('EXCHANGE_DOWNLOAD_AUTHORITY_CHANGED');
    this.grants.assertActor(scan.actor_user_id);
    return scan;
  }
  private header(raw: unknown, id: string, revision: number, actor: string): ExchangeV3GrantHeader {
    const header = exchangeV3GrantHeaderSchema.parse(raw);
    if (
      header.grantId !== id ||
      header.revision !== revision ||
      header.actorUserId !== actor ||
      header.state !== 'ACTIVE'
    )
      throw new ConflictException('EXCHANGE_DOWNLOAD_AUTHORITY_CHANGED');
    return header;
  }
  private active(entity: ExchangeV3AccessEntity): boolean {
    return (
      entity.status === 'ACTIVE' &&
      entity.bindingId !== null &&
      entity.checkedAt !== null &&
      Date.parse(entity.checkedAt) <= Date.now() + 30000 &&
      entity.validUntil !== null &&
      Date.parse(entity.validUntil) > Date.now()
    );
  }

  async refreshAccess(
    id: string,
    revision: number,
    remote: ExchangeV3Remote,
    deadline?: number,
  ): Promise<void> {
    const scan = await this.reserve(id, revision);
    try {
      const header = this.header(
        await remote(`/grants/${id}`, deadline),
        id,
        revision,
        scan.actor_user_id,
      );
      const resume =
        scan.remote_access_revision !== null &&
        Number(scan.remote_access_revision) === header.accessRevision &&
        scan.remote_access_sweep_started_at !== null &&
        scan.remote_access_sweep_started_at.getTime() > Date.now() - 300000;
      const cursor = resume ? scan.remote_access_cursor : null;
      const sweep =
        resume && scan.remote_access_sweep_id ? scan.remote_access_sweep_id : randomUUID();
      const query = new URLSearchParams();
      if (cursor !== null) query.set('cursor', cursor);
      const page = exchangeV3AccessPageSchema.parse(
        await remote(`/grants/${id}/access${query.size ? '?' + query : ''}`, deadline),
      );
      if (
        page.grantId !== id ||
        page.grantRevision !== revision ||
        page.accessRevision !== header.accessRevision ||
        (page.nextCursor === cursor && cursor !== null)
      )
        throw new ConflictException('EXCHANGE_DOWNLOAD_AUTHORITY_CHANGED');
      await this.prisma.$transaction(async (tx) => {
        const current = (
          await tx.$queryRaw<
            Array<{ id: string }>
          >`SELECT id FROM statistics_exchange_grants WHERE id=${id}::uuid AND revision=${revision} AND state='ACTIVE' AND remote_access_version=${scan.remote_access_version} FOR UPDATE`
        )[0];
        if (!current) throw new ConflictException('EXCHANGE_AUTHORITY_CHECK_SUPERSEDED');
        if (cursor !== null && page.entities.length) {
          const duplicate = (
            await tx.$queryRaw<
              Array<{ entity_id: string }>
            >`SELECT entity_id FROM statistics_exchange_entities WHERE grant_id=${id}::uuid AND remote_access_seen=${sweep}::uuid AND (kind,entity_id) IN (SELECT kind,entity_id FROM jsonb_to_recordset(${JSON.stringify(page.entities.map((e) => ({ kind: e.kind, entity_id: e.entityId })))}::jsonb) AS p(kind text,entity_id text)) LIMIT 1`
          )[0];
          if (duplicate) throw new Error('EXCHANGE_DUPLICATE_ROW');
        }
        for (const entity of page.entities) await this.applyEntity(tx, id, revision, entity, sweep);
        // FLAG: A partial compact page is not the roster. Only a completed same-revision sweep revokes absences.
        if (page.nextCursor === null)
          await tx.$executeRaw`UPDATE statistics_exchange_entities SET remote_valid_until=now(),remote_binding_id=NULL WHERE grant_id=${id}::uuid AND remote_access_seen IS DISTINCT FROM ${sweep}::uuid`;
        await this.invalidate(tx, id, revision);
        await tx.$executeRaw`UPDATE statistics_exchange_grants SET remote_access_cursor=${page.nextCursor},remote_access_revision=${header.accessRevision},remote_access_sweep_id=${page.nextCursor === null ? null : sweep}::uuid,remote_access_sweep_started_at=CASE WHEN ${page.nextCursor === null} THEN NULL WHEN ${cursor === null} THEN now() ELSE remote_access_sweep_started_at END,last_remote_access_at=CASE WHEN ${page.nextCursor === null} THEN now() ELSE last_remote_access_at END,remote_access_error=NULL,next_remote_access_at=now()+CASE WHEN ${page.nextCursor !== null} THEN interval '1 second' ELSE interval '1 minute' END WHERE id=${id}::uuid`;
      });
    } catch (error) {
      const failure = classifyExchangeFailure(error);
      await this.prisma
        .$executeRaw`UPDATE statistics_exchange_grants SET remote_access_error=${failure.code},last_remote_access_error_at=now(),remote_access_cursor=CASE WHEN ${failure.code === 'REVISION_CONFLICT'} THEN NULL ELSE remote_access_cursor END,remote_access_sweep_id=CASE WHEN ${failure.code === 'REVISION_CONFLICT'} THEN NULL ELSE remote_access_sweep_id END WHERE id=${id}::uuid AND revision=${revision} AND remote_access_version=${scan.remote_access_version}`;
      throw error;
    }
  }

  private async applyEntity(
    tx: Prisma.TransactionClient,
    id: string,
    revision: number,
    entity: ExchangeV3AccessEntity,
    sweep?: string,
  ): Promise<void> {
    const active = this.active(entity);
    const until = active
      ? new Date(Math.min(Date.parse(entity.validUntil!), Date.now() + 300000))
      : new Date();
    await tx.$executeRaw`UPDATE statistics_exchange_entities SET remote_valid_until=CASE WHEN profile=${entity.profile} THEN ${until} ELSE now() END,remote_binding_id=CASE WHEN profile=${entity.profile} THEN ${active ? entity.bindingId : null}::uuid ELSE NULL END,remote_binding_revision=${entity.bindingRevision},remote_access_scopes=${JSON.stringify(entity.permittedScopes)}::jsonb,remote_is_public=${entity.isPublic},remote_access_seen=COALESCE(${sweep ?? null}::uuid,remote_access_seen) WHERE grant_id=${id}::uuid AND entity_id=${entity.entityId} AND kind=${entity.kind} AND EXISTS(SELECT 1 FROM statistics_exchange_grants WHERE id=${id}::uuid AND revision=${revision} AND state='ACTIVE')`;
  }
  private async invalidate(
    tx: Prisma.TransactionClient,
    id: string,
    revision: number,
  ): Promise<void> {
    await tx.$executeRaw`UPDATE statistics_exchange_imports p SET remote_valid_until=CASE WHEN e.remote_binding_id::text=p.manifest->>'bindingId' AND NOT EXISTS(
        SELECT 1 FROM jsonb_array_elements(COALESCE(p.v3_content->'scopes',p.manifest->'metrics')) s
        WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(e.remote_access_scopes,'[]'::jsonb)) a
          WHERE a->>'metric'=s->>'metric' AND (a->>'horizon') IS NOT DISTINCT FROM (s->>'horizon'))
      ) THEN e.remote_valid_until ELSE now() END FROM statistics_exchange_entities e WHERE p.grant_id=${id}::uuid AND p.grant_revision=${revision} AND e.grant_id=p.grant_id AND e.kind=p.kind AND e.entity_id=p.entity_id`;
    await tx.$executeRaw`DELETE FROM statistics_exchange_downloads d USING statistics_exchange_entities e WHERE d.grant_id=${id}::uuid AND e.grant_id=d.grant_id AND e.entity_id=d.entity_id AND e.kind=d.kind AND (e.remote_valid_until<=now() OR e.remote_binding_id IS DISTINCT FROM d.remote_binding_id)`;
  }

  async exactAccess(
    id: string,
    revision: number,
    entityId: string,
    kind: 'CHANNEL' | 'CHAT',
    remote: ExchangeV3Remote,
    deadline?: number,
  ): Promise<ExchangeV3AccessEntity> {
    const scan = await this.reserve(id, revision);
    const header = this.header(
      await remote(`/grants/${id}`, deadline),
      id,
      revision,
      scan.actor_user_id,
    );
    const query = new URLSearchParams({ entityId, kind });
    const page = exchangeV3AccessPageSchema.parse(
      await remote(`/grants/${id}/access?${query}`, deadline),
    );
    if (
      page.grantId !== id ||
      page.grantRevision !== revision ||
      page.accessRevision !== header.accessRevision ||
      page.nextCursor !== null ||
      page.entities.length > 1 ||
      (page.entities[0] &&
        (page.entities[0].entityId !== entityId || page.entities[0].kind !== kind))
    )
      throw new Error('EXCHANGE_IDENTITY_MISMATCH');
    const entity = page.entities[0];
    await this.prisma.$transaction(async (tx) => {
      const current = (
        await tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT id FROM statistics_exchange_grants WHERE id=${id}::uuid AND revision=${revision} AND state='ACTIVE' AND remote_access_version=${scan.remote_access_version} FOR UPDATE`
      )[0];
      if (!current) throw new ConflictException('EXCHANGE_AUTHORITY_CHECK_SUPERSEDED');
      if (entity) await this.applyEntity(tx, id, revision, entity);
      else
        await tx.$executeRaw`UPDATE statistics_exchange_entities SET remote_valid_until=now(),remote_binding_id=NULL WHERE grant_id=${id}::uuid AND kind=${kind} AND entity_id=${entityId}`;
      await this.invalidate(tx, id, revision);
    });
    if (!entity || !this.active(entity)) throw new Error('EXCHANGE_ACCESS_DENIED');
    return entity;
  }

  async pull(
    id: string,
    revision: number,
    options: ExchangePullOptions | undefined,
    remote: ExchangeV3Remote,
    activate: ExchangeV3Activate,
  ): Promise<ExchangePullResult> {
    const deadline = options?.deadline ?? Date.now() + 50000;
    const local = await this.grants.row(id);
    if (!local || local.state !== 'ACTIVE' || Number(local.revision) !== revision)
      throw new ConflictException('EXCHANGE_DOWNLOAD_AUTHORITY_CHANGED');
    this.grants.assertActor(local.actor_user_id);
    const candidates = await this.prisma.$queryRaw<
      Array<{
        entity_id: string;
        kind: 'CHAT' | 'CHANNEL';
        profile: 'moderation' | 'publisher';
        stats_failure_count: number;
      }>
    >`SELECT e.entity_id,e.kind,e.profile,e.stats_failure_count FROM statistics_exchange_entities e JOIN marketplace_bindings b ON b.id=e.binding_id WHERE e.grant_id=${id}::uuid AND ${marketplaceLocalGrantSql('b')} AND (${!options} OR e.next_stats_at<=now()) AND (${options?.afterEntityKey ?? null}::text IS NULL OR e.kind||':'||e.entity_id>${options?.afterEntityKey ?? null}) ORDER BY e.kind,e.entity_id LIMIT ${Math.min(100, options?.maxEntities ?? 100)}`;
    let last: string | null = null,
      failures = 0,
      completedEntities = 0;
    let lastError: ExchangePullResult['lastError'] = null;
    for (const entity of candidates) {
      if (Date.now() >= deadline - 1000) break;
      last = exchangeEntityKey({ entityId: entity.entity_id, kind: entity.kind });
      let scope: ExchangeDownloadScope | undefined,
        download: ExchangeDownload | null = null;
      const lease = randomUUID();
      let phase = 'RIGHTS';
      try {
        await this.prisma
          .$executeRaw`UPDATE statistics_exchange_entities SET last_stats_attempt_at=now() WHERE grant_id=${id}::uuid AND entity_id=${entity.entity_id} AND kind=${entity.kind}`;
        const access = await this.exactAccess(
          id,
          revision,
          entity.entity_id,
          entity.kind,
          remote,
          deadline,
        );
        if (access.profile !== entity.profile) throw new Error('EXCHANGE_IDENTITY_MISMATCH');
        const { binding } = await this.grants.binding(id, entity.entity_id, entity.kind);
        scope = {
          grantId: id,
          grantRevision: revision,
          entityId: entity.entity_id,
          kind: entity.kind,
          localBindingId: binding.id,
          remoteBindingId: access.bindingId!,
          grantLeaseId: options?.leaseId,
        };
        download = await this.downloads.claim(scope, lease);
        if (download && !download.v3_head) {
          await this.downloads.discard(scope, download.id, lease);
          download = null;
        }
        let head: ExchangeV3Head;
        if (download) head = exchangeV3HeadSchema.parse(download.v3_head);
        else {
          phase = 'PAGE';
          const imported = (
            await this.prisma.$queryRaw<
              Array<{ v3_content: unknown }>
            >`SELECT v3_content FROM statistics_exchange_imports WHERE grant_id=${id}::uuid AND grant_revision=${revision} AND kind=${entity.kind} AND entity_id=${entity.entity_id}`
          )[0];
          const previous = imported?.v3_content
            ? exchangeV3ContentSchema.parse(imported.v3_content)
            : null;
          const query = new URLSearchParams({ entityId: entity.entity_id, kind: entity.kind });
          if (previous) query.set('knownContentHash', previous.contentHash);
          head = validateExchangeV3Head(
            await remote(`/grants/${id}/statistics/head?${query}`, deadline),
            Date.now(),
            previous?.contentHash,
          );
          this.checkHead(head, id, revision, entity.entity_id, entity.kind, access);
          if (Date.parse(head.access.validUntil) <= Date.now())
            throw new Error('EXCHANGE_ACCESS_DENIED');
          await this.prisma
            .$executeRaw`UPDATE statistics_exchange_entities SET remote_statistics_health=${JSON.stringify(head.health)}::jsonb WHERE grant_id=${id}::uuid AND kind=${entity.kind} AND entity_id=${entity.entity_id}`;
          if (!head.content || head.unchanged) {
            await this.prisma
              .$executeRaw`UPDATE statistics_exchange_entities SET next_stats_at=now()+interval '5 minutes',stats_error=NULL,stats_error_phase=NULL,stats_failure_count=0 WHERE grant_id=${id}::uuid AND kind=${entity.kind} AND entity_id=${entity.entity_id}`;
            continue;
          }
        }
        this.checkHead(head, id, revision, entity.entity_id, entity.kind, access);
        const content = head.content!;
        scope.v3Head = head;
        if (!download || download.state === 'DOWNLOADING') {
          phase = 'PAGE';
          const index = download?.page_count ?? 0;
          const query = new URLSearchParams({ entityId: entity.entity_id, kind: entity.kind });
          const page =
            content.pageCount === 0
              ? null
              : validateExchangeV3StatisticsPage(
                  await remote(
                    `/grants/${id}/statistics/generations/${content.generationId}/pages/${index}?${query}`,
                    deadline,
                  ),
                  head,
                );
          if (page && page.pageIndex !== index) throw new Error('EXCHANGE_PAGE_SEQUENCE');
          download = await this.downloads.append(scope, lease, download, {
            manifest: exchangeV3LegacyManifest(head),
            rows: page?.rows ?? [],
            nextCursor: page?.nextPageIndex === null || !page ? null : String(page.nextPageIndex),
          });
          await this.prisma
            .$executeRaw`UPDATE statistics_exchange_entities SET next_stats_at=now()+interval '1 second' WHERE grant_id=${id}::uuid AND kind=${entity.kind} AND entity_id=${entity.entity_id}`;
        }
        if (download.state !== 'READY' || Date.now() >= deadline - 1000) continue;
        phase = 'VERIFY';
        const assembled = await this.downloads.assemble(download);
        if (content.pageCount !== 0 && download.page_count !== content.pageCount)
          throw new Error('EXCHANGE_PAGE_SEQUENCE');
        const latest = await this.exactAccess(
          id,
          revision,
          entity.entity_id,
          entity.kind,
          remote,
          deadline,
        );
        if (
          latest.bindingId !== head.bindingId ||
          latest.profile !== entity.profile ||
          latest.isPublic !== access.isPublic
        )
          throw new ConflictException('EXCHANGE_DOWNLOAD_AUTHORITY_CHANGED');
        const permitted = new Set(
          latest.permittedScopes.map((s) =>
            s.metric === 'REACH' ? `REACH:${s.horizon}` : s.metric,
          ),
        );
        if (
          assembled.rows.some(
            (r) =>
              !permitted.has(r.data.metric === 'REACH' ? `REACH:${r.data.horizon}` : r.data.metric),
          ) ||
          ((!marketplaceBindingMetadataSchema.parse(binding.metadata).isPublic ||
            !latest.isPublic) &&
            assembled.rows.some(
              (r) => r.data.metric === 'REACH' || r.data.metric === 'PUBLICATION_HOUR',
            ))
        )
          throw new Error('EXCHANGE_METRIC_SCOPE_MISMATCH');
        phase = 'ACTIVATE';
        if (
          await activate(
            assembled.manifest,
            canonicalExchangeMeasurements(assembled.rows),
            binding.id,
            options?.leaseId,
            download,
            content,
            latest.bindingRevision,
          )
        )
          completedEntities++;
        download = null;
      } catch (error) {
        failures++;
        const failure = classifyExchangeFailure(error);
        lastError = {
          code: failure.code,
          phase,
          entityKey: last!,
          retryAfterMs: failure.retryAfterMs,
        };
        if (scope && download && failure.resetStaging)
          await this.downloads.discard(scope, download.id, lease).catch(() => undefined);
        const delay = exchangeRetryDelay(failure, entity.stats_failure_count + 1);
        await this.prisma
          .$executeRaw`UPDATE statistics_exchange_entities e SET stats_error=${failure.code},stats_error_phase=${phase},stats_failure_count=LEAST(stats_failure_count+1,100),next_stats_at=now()+${delay}*interval '1 millisecond',remote_valid_until=CASE WHEN ${failure.recheckAccess} THEN now() ELSE e.remote_valid_until END FROM statistics_exchange_grants g WHERE e.grant_id=g.id AND g.id=${id}::uuid AND g.revision=${revision} AND g.state='ACTIVE' AND e.kind=${entity.kind} AND e.entity_id=${entity.entity_id} AND (${!options} OR g.lease_id=${options?.leaseId ?? null}::uuid AND g.lease_until>now())`;
        if (!options) throw error;
      } finally {
        if (scope && download)
          await this.downloads.release(scope, download.id, lease).catch(() => undefined);
      }
    }
    const remaining = (
      await this.prisma.$queryRaw<
        Array<{ pending: boolean; next_at: Date | null; further: boolean }>
      >`SELECT min(e.next_stats_at) AS next_at,EXISTS(SELECT 1 FROM statistics_exchange_downloads WHERE grant_id=${id}::uuid AND grant_revision=${revision}) AS pending,EXISTS(SELECT 1 FROM statistics_exchange_entities WHERE grant_id=${id}::uuid AND next_stats_at<=now() AND kind||':'||entity_id>${last ?? ''}) AS further FROM statistics_exchange_entities e JOIN marketplace_bindings b ON b.id=e.binding_id WHERE e.grant_id=${id}::uuid AND ${marketplaceLocalGrantSql('b')}`
    )[0];
    const nextCursor = last && remaining?.further ? last : null;
    return {
      nextCursor,
      failures,
      completedEntities,
      pending: nextCursor !== null || remaining?.pending === true,
      nextDelayMs: nextCursor
        ? 1000
        : Math.max(
            1000,
            Math.min(300000, (remaining?.next_at?.getTime() ?? Date.now() + 300000) - Date.now()),
          ),
      lastError,
    };
  }
  private checkHead(
    head: ExchangeV3Head,
    id: string,
    revision: number,
    entityId: string,
    kind: string,
    access: ExchangeV3AccessEntity,
  ): void {
    if (
      head.grantId !== id ||
      head.grantRevision !== revision ||
      head.entityId !== entityId ||
      head.kind !== kind ||
      head.bindingId !== access.bindingId ||
      (head.content && head.content.origin !== 'EXCHANGE')
    )
      throw new Error('EXCHANGE_IDENTITY_MISMATCH');
    if (
      head.content &&
      head.content.scopes.some(
        (scope) =>
          !access.permittedScopes.some(
            (allowed) =>
              allowed.metric === scope.metric &&
              (allowed.metric !== 'REACH' ||
                (scope.metric === 'REACH' && allowed.horizon === scope.horizon)),
          ),
      )
    )
      throw new Error('EXCHANGE_METRIC_SCOPE_MISMATCH');
    if (
      head.content &&
      createHash('sha256').update(exchangeV3ContentCanonical(head.content)).digest('hex') !==
        head.content.contentHash
    )
      throw new Error('EXCHANGE_CHECKSUM_MISMATCH');
  }
}
