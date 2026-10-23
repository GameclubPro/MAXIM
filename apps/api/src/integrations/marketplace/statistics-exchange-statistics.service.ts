import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  exchangeManifestSchema,
  exchangeSelectedStatisticsSchema,
  exchangeMeasurementSchema,
  exchangeGrantSchema,
  exchangeMetricSchema,
  exchangeV3ScopeSchema,
  exchangeEntityKey,
  validateExchangePage,
  type ExchangeManifest,
  type ExchangeMeasurement,
  type ExchangeStatisticsPage,
  type ExchangeGrant,
  type ExchangeV3Content,
} from '@maxim/contracts';
import {
  marketplaceStatisticRowSchema,
  marketplaceStatisticsManifestSchema,
  marketplaceBindingMetadataSchema,
} from '@maxim/contracts/marketplace-integration';
import { PrismaService } from '../../prisma/prisma.service';
import { MarketplaceStatisticsService } from './marketplace-statistics.service';
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
  exchangeRetryAfter,
  ExchangeResponseError,
} from './statistics-exchange-errors';
import { StatisticsExchangeV3ConsumerService } from './statistics-exchange-v3-consumer.service';
import { statisticsExchangeActorAllowed } from './statistics-exchange.settings';
import {
  canonicalExchangeMeasurements,
  exchangeMeasurementsHash,
  exchangeMeasurementComplete,
  selectExchangeMeasurements,
  exchangeRetentionFrom,
  retainedExchangeMeasurements,
  exchangeMetricError,
} from './statistics-exchange-values';

export const exchangeStatisticsQuerySchema = z
  .object({
    entityId: z.string().regex(/^-[1-9]\d{0,19}$/u),
    kind: z.enum(['CHAT', 'CHANNEL']),
    generationId: z.string().uuid().optional(),
    cursor: z.string().max(2048).optional(),
  })
  .strict();
const cursorSchema = z
  .object({ generationId: z.string().uuid(), offset: z.number().int().min(0).max(3000) })
  .strict();
type StoredGeneration = { id: string; manifest: unknown; rows: unknown };
type ImportedProjection = { manifest: unknown; rows: unknown };

const storedRows = z.array(exchangeMeasurementSchema).max(3000);
const reverseBase = 'https://major-maksimov.ru/market/api/integrations/maxim/v2';

@Injectable()
export class StatisticsExchangeStatisticsService {
  private readonly downloads: StatisticsExchangeDownloadsService;
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly grants: StatisticsExchangeGrantsService,
    private readonly native: MarketplaceStatisticsService,
    @Optional() downloads?: StatisticsExchangeDownloadsService,
    @Optional() private readonly v3?: StatisticsExchangeV3ConsumerService,
  ) {
    this.downloads = downloads ?? new StatisticsExchangeDownloadsService(prisma);
  }

  async refreshRemoteAccess(id: string, expectedRevision: number): Promise<void> {
    const remote = (path: string, deadline?: number) => this.remote(path, deadline, 3);
    if (this.v3 && (await this.v3.supported(id, remote)))
      return this.v3.refreshAccess(id, expectedRevision, remote);
    await this.remoteGrant(id, expectedRevision);
  }

  private async remoteGrant(
    id: string,
    expectedRevision: number,
    deadline?: number,
  ): Promise<ExchangeGrant> {
    // FLAG: Reserve before I/O. A delayed older request cannot resurrect authority after a newer denial.
    const checks = await this.prisma.$queryRaw<
      Array<{ remote_access_version: bigint }>
    >`UPDATE statistics_exchange_grants SET remote_access_version=remote_access_version+1,last_remote_access_attempt_at=now()
      WHERE id=${id}::uuid AND revision=${expectedRevision} AND state='ACTIVE' RETURNING remote_access_version`;
    if (!checks[0]) throw new ConflictException('Согласие изменилось');
    const checkVersion = checks[0].remote_access_version;
    try {
      const remote = exchangeGrantSchema.parse(
        await this.remote(`/grants/${encodeURIComponent(id)}`, deadline),
      );
      await this.confirmRemoteGrant(id, expectedRevision, checkVersion, remote);
      return remote;
    } catch (error) {
      // FLAG: An obsolete failure cannot overwrite the health of a newer successful authority check.
      await this.prisma
        .$executeRaw`UPDATE statistics_exchange_grants SET remote_access_error='REMOTE_ACCESS_UNAVAILABLE',last_remote_access_error_at=now()
        WHERE id=${id}::uuid AND revision=${expectedRevision} AND state='ACTIVE' AND remote_access_version=${checkVersion}
          AND remote_access_error IS DISTINCT FROM 'REMOTE_ACCESS_REVOKED'`;
      throw error;
    }
  }

  private async confirmRemoteGrant(
    id: string,
    expectedRevision: number,
    checkVersion: bigint,
    remote: ExchangeGrant,
  ): Promise<void> {
    const local = await this.grants.row(id);
    if (!local || local.state !== 'ACTIVE' || Number(local.revision) !== expectedRevision)
      throw new ConflictException('Согласие изменилось');
    this.grants.assertActor(local.actor_user_id);
    const matches =
      remote.grantId === id &&
      remote.actorUserId === local.actor_user_id &&
      remote.revision === expectedRevision &&
      remote.state === 'ACTIVE';
    const untilLimit = Date.now() + 5 * 60_000;
    const confirmed = matches
      ? remote.entities.flatMap((entity) => {
          const b = entity.binding;
          if (
            entity.status !== 'ACTIVE' ||
            !b ||
            b.state !== 'ACTIVE' ||
            b.actorUserId !== local.actor_user_id ||
            b.entityId !== entity.entityId ||
            b.kind !== entity.kind ||
            b.profile !== entity.profile ||
            !b.validUntil ||
            Date.parse(b.validUntil) <= Date.now()
          )
            return [];
          return [
            {
              entity_id: entity.entityId,
              kind: entity.kind,
              profile: entity.profile,
              binding_id: b.id,
              valid_until: new Date(Math.min(Date.parse(b.validUntil), untilLimit)).toISOString(),
            },
          ];
        })
      : [];
    await this.prisma.$transaction(async (tx) => {
      // FLAG: Remote proof belongs to the exact peer revision/entity; local MAX rights never renew it.
      const active = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM statistics_exchange_grants WHERE id=${id}::uuid AND revision=${expectedRevision} AND state='ACTIVE' AND remote_access_version=${checkVersion} FOR UPDATE`;
      if (!active[0]) throw new ConflictException('EXCHANGE_AUTHORITY_CHECK_SUPERSEDED');
      await tx.$executeRaw`WITH confirmed AS MATERIALIZED(SELECT * FROM jsonb_to_recordset(${JSON.stringify(confirmed)}::jsonb) AS c(entity_id text,kind text,profile text,binding_id uuid,valid_until timestamptz)),
        scoped AS MATERIALIZED(SELECT e.entity_id,e.kind,c.binding_id,c.valid_until FROM statistics_exchange_entities e
          LEFT JOIN confirmed c ON c.entity_id=e.entity_id AND c.kind=e.kind AND c.profile=e.profile WHERE e.grant_id=${id}::uuid)
        UPDATE statistics_exchange_entities e SET remote_valid_until=COALESCE(s.valid_until,now()),remote_binding_id=s.binding_id
          FROM scoped s WHERE e.grant_id=${id}::uuid AND e.entity_id=s.entity_id AND e.kind=s.kind`;
      await tx.$executeRaw`UPDATE statistics_exchange_imports p SET remote_valid_until=CASE WHEN e.remote_binding_id::text=p.manifest->>'bindingId' THEN e.remote_valid_until ELSE now() END
        FROM statistics_exchange_entities e WHERE p.grant_id=${id}::uuid AND p.grant_revision=${expectedRevision} AND e.grant_id=p.grant_id AND e.entity_id=p.entity_id AND e.kind=p.kind`;
      await tx.$executeRaw`DELETE FROM statistics_exchange_downloads d USING statistics_exchange_entities e
        WHERE d.grant_id=${id}::uuid AND e.grant_id=d.grant_id AND e.entity_id=d.entity_id AND e.kind=d.kind
          AND (e.remote_valid_until<=now() OR e.remote_binding_id IS DISTINCT FROM d.remote_binding_id)`;
      await tx.$executeRaw`UPDATE statistics_exchange_grants SET last_remote_access_at=now(),remote_access_error=${matches ? null : 'REMOTE_ACCESS_REVOKED'} WHERE id=${id}::uuid AND revision=${expectedRevision}`;
    });
    if (!matches) throw new ConflictException('Разрешение второй стороны изменилось');
  }

  async page(id: string, raw: unknown): Promise<ExchangeStatisticsPage> {
    const query = exchangeStatisticsQuerySchema.parse(raw);
    const { grant, binding } = await this.grants.binding(id, query.entityId, query.kind);
    const publicChannel =
      binding.kind === 'CHANNEL' &&
      marketplaceBindingMetadataSchema.parse(binding.metadata).isPublic === true;
    let cursor: z.infer<typeof cursorSchema> | undefined;
    if (query.cursor) {
      try {
        cursor = cursorSchema.parse(
          JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')),
        );
      } catch {
        throw new ConflictException('Некорректный курсор статистики');
      }
      if (query.generationId && query.generationId !== cursor.generationId)
        throw new ConflictException('Курсор другой выгрузки');
    }
    let generationId = query.generationId ?? cursor?.generationId;
    if (!generationId) {
      const nativeId = await this.native.createGeneration(binding);
      const snapshots = await this.prisma.$queryRaw<
        Array<{ manifest: unknown; rows: unknown }>
      >`SELECT manifest,rows FROM marketplace_statistics_generations WHERE id=${nativeId}::uuid AND binding_id=${binding.id}::uuid`;
      if (!snapshots[0]) throw new NotFoundException('Наблюдения ещё не готовы');
      const source = marketplaceStatisticsManifestSchema.parse(snapshots[0].manifest);
      const nativeRows = z
        .array(marketplaceStatisticRowSchema)
        .max(3000)
        .parse(snapshots[0].rows)
        .filter(
          (row) =>
            row.bucket >= source.from &&
            row.bucket < source.to &&
            (publicChannel || (row.metric !== 'REACH' && row.metric !== 'PUBLICATION_HOUR')),
        );
      const prior = await this.prisma.$queryRaw<
        StoredGeneration[]
      >`SELECT id,manifest,rows FROM statistics_exchange_generations WHERE grant_id=${id}::uuid AND grant_revision=${grant.revision} AND entity_id=${query.entityId} AND kind=${query.kind} AND origin='MAXIM' ORDER BY producer_revision DESC,created_at DESC,id DESC LIMIT 1`;
      const previous = prior[0] ? exchangeManifestSchema.parse(prior[0].manifest) : null;
      const dataHash = exchangeMeasurementsHash(
        nativeRows.map((data) => ({
          origin: 'MAXIM',
          method: 'utc-buckets-v1',
          revision: 0,
          data,
        })),
      );
      const previousHash = prior[0]
        ? exchangeMeasurementsHash(
            storedRows.parse(prior[0].rows).map((row) => ({ ...row, revision: 0 })),
          )
        : null;
      if (
        previous &&
        previous.metrics.length === (publicChannel ? 4 : 2) &&
        previous.metrics.every(
          (metric) =>
            metric.error ===
            exchangeMetricError(metric.metric, binding.collection_error, binding.history_anomaly),
        ) &&
        dataHash === previousHash &&
        previous.from === source.from &&
        Date.parse(previous.asOf) > Date.now() - 4 * 60_000
      )
        generationId = previous.generationId;
      else {
        const sequence = await this.prisma.$queryRaw<
          Array<{ producer_revision: bigint }>
        >`UPDATE statistics_exchange_grants SET producer_revision=producer_revision+1 WHERE id=${id}::uuid AND revision=${grant.revision} AND state='ACTIVE' RETURNING producer_revision`;
        if (!sequence[0]) throw new ConflictException('Согласие изменилось');
        const producerRevision = Number(sequence[0].producer_revision);
        const rows = canonicalExchangeMeasurements(
          nativeRows.map((data) => ({
            origin: 'MAXIM',
            method: 'utc-buckets-v1',
            revision: producerRevision,
            data,
          })),
        );
        generationId = randomUUID();
        const asOf = new Date().toISOString();
        const manifest = exchangeManifestSchema.parse({
          version: 2,
          grantId: id,
          grantRevision: Number(grant.revision),
          generationId,
          bindingId: binding.id,
          entityId: query.entityId,
          kind: query.kind,
          origin: 'MAXIM',
          producerRevision,
          method: 'utc-buckets-v1',
          from: source.from,
          to: asOf,
          asOf,
          rowCount: rows.length,
          sha256: exchangeMeasurementsHash(rows),
          complete: source.complete,
          horizonToleranceSeconds: 900,
          metrics: exchangeMetricSchema.options
            .filter((metric) => publicChannel || metric === 'AUDIENCE' || metric === 'MEMBERSHIP')
            .map((metric) => {
              const points = rows.filter((row) => row.data.metric === metric);
              const latest = points.reduce<string | null>(
                (last, row) =>
                  row.data.observedAt && (!last || row.data.observedAt > last)
                    ? row.data.observedAt
                    : last,
                null,
              );
              const checked =
                metric === 'AUDIENCE'
                  ? (binding.native_audience_checked_at ?? (latest ? new Date(latest) : null))
                  : metric === 'MEMBERSHIP'
                    ? latest
                      ? new Date(latest)
                      : null
                    : (binding.native_history_checked_at ?? (latest ? new Date(latest) : null));
              return {
                metric,
                complete: points.length > 0 && points.every(exchangeMeasurementComplete),
                checkedAt: checked?.toISOString() ?? null,
                nextExpectedAt: checked
                  ? new Date(checked.getTime() + 5 * 60_000).toISOString()
                  : null,
                error: exchangeMetricError(
                  metric,
                  binding.collection_error,
                  binding.history_anomaly,
                ),
              };
            }),
        });
        await this.store(manifest, rows, binding.id);
      }
    }
    const result = await this.prisma.$queryRaw<
      StoredGeneration[]
    >`SELECT id,manifest,rows FROM statistics_exchange_generations WHERE id=${generationId}::uuid AND grant_id=${id}::uuid AND grant_revision=${grant.revision} AND entity_id=${query.entityId} AND kind=${query.kind} AND origin='MAXIM'`;
    if (!result[0]) throw new NotFoundException('Выгрузка недоступна');
    const manifest = exchangeManifestSchema.parse(result[0].manifest),
      rows = storedRows.parse(result[0].rows);
    if (manifest.from < exchangeRetentionFrom())
      throw new NotFoundException('Выгрузка вышла за срок хранения');
    const offset = cursor?.offset ?? 0;
    if (offset > rows.length) throw new ConflictException('Некорректная позиция курсора');
    const current = await this.grants.binding(id, query.entityId, query.kind);
    if (current.grant.revision !== grant.revision)
      throw new ConflictException('Согласие изменилось');
    if (
      (current.binding.kind !== 'CHANNEL' ||
        marketplaceBindingMetadataSchema.parse(current.binding.metadata).isPublic !== true) &&
      rows.some((row) => row.data.metric === 'REACH' || row.data.metric === 'PUBLICATION_HOUR')
    )
      throw new ForbiddenException('Показатели недоступны для этой площадки');
    return validateExchangePage({
      manifest,
      rows: rows.slice(offset, offset + 200),
      nextCursor:
        offset + 200 < rows.length
          ? Buffer.from(JSON.stringify({ generationId, offset: offset + 200 })).toString(
              'base64url',
            )
          : null,
    });
  }

  private async store(
    manifest: ExchangeManifest,
    rows: ExchangeMeasurement[],
    bindingId: string,
    leaseId?: string,
    download?: ExchangeDownload,
    v3Content?: ExchangeV3Content,
    remoteBindingRevision?: number,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const finish = async (successful: boolean) => {
        if (download) await this.downloads.consume(tx, download, successful);
        return successful;
      };
      // FLAG: The grant row serializes revocation, lease loss and generation publication.
      const locked = await tx.$queryRaw<
        Array<{ id: string; lease_id: string | null; leased: boolean }>
      >`SELECT id,lease_id,(lease_until>now()) AS leased FROM statistics_exchange_grants
        WHERE id=${manifest.grantId}::uuid AND state='ACTIVE' AND revision=${manifest.grantRevision} FOR UPDATE`;
      if (!locked[0]) throw new ConflictException('Согласие или аренда изменились');
      if (leaseId !== undefined && (locked[0].lease_id !== leaseId || locked[0].leased !== true))
        throw new ConflictException('EXCHANGE_DOWNLOAD_LEASE_CHANGED');
      const current = await tx.$queryRaw<
        Array<{
          id: string;
          remote_valid_until: Date;
          metadata: unknown;
          remote_binding_revision: bigint | null;
          remote_access_scopes: unknown;
        }>
      >`SELECT g.id,e.remote_valid_until,b.metadata,e.remote_binding_revision,e.remote_access_scopes FROM statistics_exchange_grants g
        JOIN statistics_exchange_entities e ON e.grant_id=g.id JOIN marketplace_bindings b ON b.id=e.binding_id
        WHERE g.id=${manifest.grantId}::uuid AND g.state='ACTIVE' AND g.revision=${manifest.grantRevision}
          AND e.entity_id=${manifest.entityId} AND e.kind=${manifest.kind} AND b.id=${bindingId}::uuid AND ${marketplaceLocalGrantSql('b')}
          AND e.remote_valid_until>now() AND (${manifest.origin === 'MAXIM'} OR e.remote_binding_id::text=${manifest.bindingId})
          AND (${leaseId === undefined} OR (g.lease_id=${leaseId ?? null}::uuid AND g.lease_until>now())) FOR UPDATE OF b`;
      if (!current[0]) throw new ConflictException('Согласие или аренда изменились');
      if (
        v3Content &&
        remoteBindingRevision !== undefined &&
        Number(current[0].remote_binding_revision) !== remoteBindingRevision
      )
        throw new ConflictException('EXCHANGE_DOWNLOAD_AUTHORITY_CHANGED');
      if (v3Content) {
        const allowed = z
          .array(exchangeV3ScopeSchema)
          .max(6)
          .parse(current[0].remote_access_scopes ?? []);
        if (
          v3Content.scopes.some(
            (scope) =>
              !allowed.some(
                (value) =>
                  value.metric === scope.metric &&
                  (value.metric !== 'REACH' ||
                    (scope.metric === 'REACH' && value.horizon === scope.horizon)),
              ),
          )
        )
          throw new ConflictException('EXCHANGE_DOWNLOAD_AUTHORITY_CHANGED');
      }
      if (
        manifest.origin === 'EXCHANGE' &&
        (manifest.kind !== 'CHANNEL' ||
          marketplaceBindingMetadataSchema.parse(current[0].metadata).isPublic !== true) &&
        rows.some((row) => row.data.metric === 'REACH' || row.data.metric === 'PUBLICATION_HOUR')
      )
        throw new ForbiddenException('EXCHANGE_METRIC_SCOPE_MISMATCH');
      if (manifest.origin === 'EXCHANGE') {
        // FLAG: Immutable transport expiry must not erase the durable producer revision fence.
        const materialized = await tx.$queryRaw<Array<{ manifest: unknown }>>`
          SELECT manifest FROM statistics_exchange_imports WHERE grant_id=${manifest.grantId}::uuid
            AND grant_revision=${manifest.grantRevision} AND entity_id=${manifest.entityId} AND kind=${manifest.kind} FOR UPDATE`;
        if (materialized[0]) {
          const prior = exchangeManifestSchema.parse(materialized[0].manifest);
          if (prior.producerRevision > manifest.producerRevision) return finish(false);
          if (
            prior.producerRevision === manifest.producerRevision &&
            (prior.generationId !== manifest.generationId || prior.sha256 !== manifest.sha256)
          )
            throw new ConflictException('Версия производителя уже использована');
        }
      }
      const previous = await tx.$queryRaw<
        StoredGeneration[]
      >`SELECT id,manifest,rows FROM statistics_exchange_generations WHERE grant_id=${manifest.grantId}::uuid
        AND grant_revision=${manifest.grantRevision} AND entity_id=${manifest.entityId} AND kind=${manifest.kind} AND origin=${manifest.origin}
        ORDER BY producer_revision DESC,created_at DESC,id DESC LIMIT 1`;
      if (previous[0]) {
        const prior = exchangeManifestSchema.parse(previous[0].manifest);
        if (manifest.origin === 'EXCHANGE' && prior.producerRevision > manifest.producerRevision)
          return finish(false);
        if (
          prior.producerRevision === manifest.producerRevision &&
          (prior.generationId !== manifest.generationId || prior.sha256 !== manifest.sha256)
        )
          throw new ConflictException('Версия производителя уже использована');
      }
      const stored =
        await tx.$executeRaw`INSERT INTO statistics_exchange_generations(id,grant_id,grant_revision,entity_id,kind,origin,producer_revision,manifest,rows,retention_from)
        VALUES(${manifest.generationId}::uuid,${manifest.grantId}::uuid,${manifest.grantRevision},${manifest.entityId},${manifest.kind},${manifest.origin},${manifest.producerRevision},${JSON.stringify(manifest)}::jsonb,${JSON.stringify(rows)}::jsonb,${new Date(manifest.from)})
        ON CONFLICT(id) DO NOTHING`;
      if (!stored) {
        const duplicate = await tx.$queryRaw<
          Array<{ manifest: unknown }>
        >`SELECT manifest FROM statistics_exchange_generations WHERE id=${manifest.generationId}::uuid`;
        if (
          !duplicate[0] ||
          JSON.stringify(exchangeManifestSchema.parse(duplicate[0].manifest)) !==
            JSON.stringify(manifest)
        )
          throw new ConflictException('Идентификатор выгрузки уже использован');
      }
      if (manifest.origin === 'EXCHANGE') {
        const previous = await tx.$queryRaw<ImportedProjection[]>`
          SELECT manifest,rows FROM statistics_exchange_imports WHERE grant_id=${manifest.grantId}::uuid
            AND grant_revision=${manifest.grantRevision} AND entity_id=${manifest.entityId} AND kind=${manifest.kind} FOR UPDATE`;
        const cutoff = exchangeRetentionFrom();
        const from = Date.parse(manifest.from),
          to = Date.parse(manifest.to);
        // FLAG: A correction replaces only its declared interval. Omitted rows inside are deletions;
        // rows outside retain their own producer revisions. Never rewrite the immutable checksum.
        const retained = previous[0]
          ? storedRows
              .parse(previous[0].rows)
              .filter(
                (row) =>
                  row.data.bucket >= cutoff &&
                  (Date.parse(row.data.bucket) < from || Date.parse(row.data.bucket) >= to),
              )
          : [];
        const merged = storedRows.parse(canonicalExchangeMeasurements([...retained, ...rows]));
        await tx.$executeRaw`INSERT INTO statistics_exchange_imports(grant_id,grant_revision,entity_id,kind,producer_revision,manifest,rows,remote_valid_until,v3_content,retention_checked_from)
          VALUES(${manifest.grantId}::uuid,${manifest.grantRevision},${manifest.entityId},${manifest.kind},${manifest.producerRevision},${JSON.stringify(manifest)}::jsonb,${JSON.stringify(merged)}::jsonb,${current[0].remote_valid_until},${v3Content === undefined ? null : JSON.stringify(v3Content)}::jsonb,${new Date(cutoff)})
          ON CONFLICT(grant_id,grant_revision,entity_id,kind) DO UPDATE SET producer_revision=EXCLUDED.producer_revision,
            manifest=EXCLUDED.manifest,rows=EXCLUDED.rows,remote_valid_until=EXCLUDED.remote_valid_until,v3_content=EXCLUDED.v3_content,retention_checked_from=EXCLUDED.retention_checked_from,updated_at=now()`;
      }
      return finish(true);
    });
  }

  private async remote(
    path: string,
    deadline = Date.now() + 5000,
    version: 2 | 3 = 2,
  ): Promise<unknown> {
    const token = this.config.get<string>('SVYAZKA_STATISTICS_EXPORT_TOKEN');
    if (!token) throw new Error('EXCHANGE_NOT_CONFIGURED');
    if (deadline <= Date.now()) throw new Error('EXCHANGE_DEADLINE');
    // FLAG: All reverse lanes and roles share the credential's durable Retry-After fence.
    const peerKey = 'EXCHANGE:' + createHash('sha256').update(token).digest('hex');
    const limited = await this.prisma.$queryRaw<Array<{ retry_after_ms: number }>>`
      SELECT CEIL(EXTRACT(EPOCH FROM(next_request_at-now()))*1000)::double precision AS retry_after_ms
      FROM statistics_exchange_peer_limits WHERE peer_key=${peerKey} AND next_request_at>now()`;
    if (limited[0]) throw new ExchangeResponseError(429, limited[0].retry_after_ms);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('EXCHANGE_DEADLINE');

    const response = await fetch(
      (version === 3 ? reverseBase.replace(/v2$/u, 'v3') : reverseBase) + path,
      {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, Math.min(5000, Math.ceil(remaining)))),
      },
    );
    if (!response.ok) {
      const retryAfter = exchangeRetryAfter(response.headers.get('retry-after'), Date.now());
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 429)
        await this.prisma.$executeRaw`
        INSERT INTO statistics_exchange_peer_limits(peer_key,next_request_at,updated_at)
        VALUES(${peerKey},now()+${Math.max(5000, retryAfter ?? 0)}*interval '1 millisecond',now())
        ON CONFLICT(peer_key) DO UPDATE SET next_request_at=GREATEST(statistics_exchange_peer_limits.next_request_at,EXCLUDED.next_request_at),updated_at=now()`;
      throw new ExchangeResponseError(response.status, retryAfter);
    }
    if (!response.body) throw new Error('EXCHANGE_UNAVAILABLE');
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    const maximumBytes =
      version === 3
        ? path === '/capabilities'
          ? 8192
          : /\/access(?:\?|$)/u.test(path)
            ? 65536
            : 131072
        : /^\/grants\/[0-9a-f-]{36}$/u.test(path)
          ? 1024 * 1024
          : 128 * 1024;
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maximumBytes) throw new Error('EXCHANGE_RESPONSE_LIMIT');
        chunks.push(part.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  private async phaseHealth(
    id: string,
    revision: number,
    entityId: string,
    kind: string,
    phase: 'RIGHTS' | 'PAGE' | 'VERIFY' | 'ACTIVATE',
    outcome: 'attempt' | 'success' | 'failure',
    leaseId?: string,
    errorCode?: string,
  ): Promise<void> {
    const key =
      outcome === 'attempt' ? 'attemptAt' : outcome === 'success' ? 'successAt' : 'failureAt';
    await this.prisma.$executeRaw`UPDATE statistics_exchange_entities e SET
      stats_phase_health=jsonb_set(stats_phase_health,ARRAY[${phase}],
        COALESCE(stats_phase_health->${phase},'{}'::jsonb)||jsonb_build_object(${key}::text,now())||
          CASE WHEN ${outcome !== 'attempt'} THEN jsonb_build_object('error',${errorCode ?? null}::text) ELSE '{}'::jsonb END),
      stats_error=CASE WHEN ${outcome === 'success'} AND stats_error_phase=${phase} THEN NULL ELSE stats_error END,
      stats_error_phase=CASE WHEN ${outcome === 'success'} AND stats_error_phase=${phase} THEN NULL ELSE stats_error_phase END
      FROM statistics_exchange_grants g WHERE e.grant_id=g.id AND g.id=${id}::uuid AND g.revision=${revision}
        AND g.state='ACTIVE' AND e.entity_id=${entityId} AND e.kind=${kind}
        AND (${leaseId === undefined} OR (g.lease_id=${leaseId ?? null}::uuid AND g.lease_until>now()))`;
  }

  async pull(
    id: string,
    expectedRevision: number,
    options?: {
      leaseId: string;
      afterEntityKey: string | null;
      maxEntities: number;
      deadline: number;
    },
  ): Promise<{
    nextCursor: string | null;
    failures: number;
    pending: boolean;
    completedEntities: number;
    nextDelayMs: number;
    lastError: {
      code: string;
      phase: string;
      entityKey: string;
      retryAfterMs: number | null;
    } | null;
  }> {
    const deadline = options?.deadline ?? Date.now() + 50_000;
    const v3Remote = (path: string, budget?: number) => this.remote(path, budget, 3);
    if (this.v3 && (await this.v3.supported(id, v3Remote, deadline)))
      return this.v3.pull(id, expectedRevision, options, v3Remote, (...args) =>
        this.store(...args),
      );
    const remoteGrant = await this.remoteGrant(id, expectedRevision, deadline);
    const local = await this.grants.read(id);
    if (
      local.state !== 'ACTIVE' ||
      remoteGrant.state !== 'ACTIVE' ||
      remoteGrant.actorUserId !== local.actorUserId ||
      remoteGrant.grantId !== id ||
      remoteGrant.revision !== expectedRevision ||
      local.revision !== expectedRevision
    )
      throw new ConflictException('Согласие изменилось');
    const schedule = await this.prisma.$queryRaw<
      Array<{ entity_id: string; kind: string; next_stats_at: Date; stats_failure_count: number }>
    >`
      SELECT entity_id,kind,next_stats_at,stats_failure_count FROM statistics_exchange_entities WHERE grant_id=${id}::uuid`;
    const eligible = local.entities
      .filter((value) => value.status === 'ACTIVE')
      .sort((a, b) => (exchangeEntityKey(a) < exchangeEntityKey(b) ? -1 : 1));
    const due = eligible.filter(
      (value) =>
        !options ||
        schedule.some(
          (s) =>
            s.entity_id === value.entityId &&
            s.kind === value.kind &&
            s.next_stats_at.getTime() <= Date.now(),
        ),
    );
    const candidates = due
      .filter(
        (value) => !options?.afterEntityKey || exchangeEntityKey(value) > options.afterEntityKey,
      )
      .slice(0, options?.maxEntities ?? 100);
    let last: string | null = null,
      failures = 0,
      completedEntities = 0;
    let lastError: {
      code: string;
      phase: string;
      entityKey: string;
      retryAfterMs: number | null;
    } | null = null;
    for (const entity of candidates) {
      if (Date.now() >= deadline - 1000) break;
      last = exchangeEntityKey(entity);
      const leaseId = randomUUID();
      let download: ExchangeDownload | null = null,
        scope: ExchangeDownloadScope | undefined,
        phase: 'RIGHTS' | 'PAGE' | 'VERIFY' | 'ACTIVATE' = 'RIGHTS';
      try {
        await this.phaseHealth(
          id,
          expectedRevision,
          entity.entityId,
          entity.kind,
          phase,
          'attempt',
          options?.leaseId,
        );
        await this.prisma
          .$executeRaw`UPDATE statistics_exchange_entities e SET last_stats_attempt_at=now()
          FROM statistics_exchange_grants g WHERE e.grant_id=g.id AND g.id=${id}::uuid AND g.revision=${expectedRevision}
            AND g.state='ACTIVE' AND e.entity_id=${entity.entityId} AND e.kind=${entity.kind}
            AND (${!options} OR (g.lease_id=${options?.leaseId ?? null}::uuid AND g.lease_until>now()))`;
        const remoteEntity = remoteGrant.entities.find(
          (v) => v.entityId === entity.entityId && v.kind === entity.kind,
        );
        if (
          !remoteEntity ||
          remoteEntity.status !== 'ACTIVE' ||
          !remoteEntity.binding ||
          remoteEntity.binding.actorUserId !== local.actorUserId ||
          remoteEntity.binding.entityId !== entity.entityId ||
          remoteEntity.binding.kind !== entity.kind ||
          remoteEntity.binding.profile !== remoteEntity.profile
        )
          throw new Error('EXCHANGE_IDENTITY_MISMATCH');
        const { binding } = await this.grants.binding(id, entity.entityId, entity.kind);
        scope = {
          grantId: id,
          grantRevision: expectedRevision,
          entityId: entity.entityId,
          kind: entity.kind,
          localBindingId: binding.id,
          remoteBindingId: remoteEntity.binding.id,
          grantLeaseId: options?.leaseId,
        };
        download = await this.downloads.claim(scope, leaseId);
        await this.phaseHealth(
          id,
          expectedRevision,
          entity.entityId,
          entity.kind,
          phase,
          'success',
          options?.leaseId,
        );
        const checkScope = (rows: ExchangeMeasurement[], remotePublic: boolean) => {
          if (
            (entity.kind !== 'CHANNEL' ||
              marketplaceBindingMetadataSchema.parse(binding.metadata).isPublic !== true ||
              !remotePublic) &&
            rows.some(
              (row) => row.data.metric === 'REACH' || row.data.metric === 'PUBLICATION_HOUR',
            )
          )
            throw new Error('EXCHANGE_METRIC_SCOPE_MISMATCH');
        };
        if (!download || download.state === 'DOWNLOADING') {
          phase = 'PAGE';
          await this.phaseHealth(
            id,
            expectedRevision,
            entity.entityId,
            entity.kind,
            phase,
            'attempt',
            options?.leaseId,
          );
          const query = new URLSearchParams({ entityId: entity.entityId, kind: entity.kind });
          if (download) query.set('generationId', download.generation_id);
          if (download && download.next_cursor !== null) query.set('cursor', download.next_cursor);
          const page = validateExchangePage(
            await this.remote(`/grants/${encodeURIComponent(id)}/statistics?${query}`, deadline),
          );
          checkScope(page.rows, remoteEntity.binding.metadata.isPublic);
          download = await this.downloads.append(scope, leaseId, download, page);
          await this.phaseHealth(
            id,
            expectedRevision,
            entity.entityId,
            entity.kind,
            phase,
            'success',
            options?.leaseId,
          );
          await this.prisma
            .$executeRaw`UPDATE statistics_exchange_entities e SET next_stats_at=now()+interval '1 second',
            stats_failure_count=CASE WHEN stats_error IS NULL THEN 0 ELSE stats_failure_count END FROM statistics_exchange_grants g
            WHERE e.grant_id=g.id AND g.id=${id}::uuid AND g.revision=${expectedRevision} AND g.state='ACTIVE'
              AND e.entity_id=${entity.entityId} AND e.kind=${entity.kind}
              AND (${!options} OR (g.lease_id=${options?.leaseId ?? null}::uuid AND g.lease_until>now()))`;
        }
        if (download.state !== 'READY' || Date.now() >= deadline - 1000) continue;
        phase = 'VERIFY';
        await this.phaseHealth(
          id,
          expectedRevision,
          entity.entityId,
          entity.kind,
          phase,
          'attempt',
          options?.leaseId,
        );
        const { manifest, rows } = await this.downloads.assemble(download);
        // FLAG: Final peer proof is HTTP work outside the activation transaction; READY survives a yield.
        const latest = await this.remoteGrant(id, expectedRevision, deadline);
        const latestEntity = latest.entities.find(
          (value) => value.entityId === entity.entityId && value.kind === entity.kind,
        );
        if (
          latest.state !== 'ACTIVE' ||
          latest.grantId !== id ||
          latest.actorUserId !== local.actorUserId ||
          latest.revision !== expectedRevision ||
          latestEntity?.status !== 'ACTIVE' ||
          latestEntity.binding?.id !== manifest.bindingId ||
          latestEntity.binding.actorUserId !== local.actorUserId ||
          latestEntity.binding.entityId !== entity.entityId ||
          latestEntity.binding.kind !== entity.kind ||
          latestEntity.binding.profile !== latestEntity.profile
        )
          throw new ConflictException('Согласие изменилось');
        checkScope(rows, latestEntity.binding.metadata.isPublic);
        await this.phaseHealth(
          id,
          expectedRevision,
          entity.entityId,
          entity.kind,
          phase,
          'success',
          options?.leaseId,
        );
        phase = 'ACTIVATE';
        await this.phaseHealth(
          id,
          expectedRevision,
          entity.entityId,
          entity.kind,
          phase,
          'attempt',
          options?.leaseId,
        );
        if (await this.store(manifest, rows, binding.id, options?.leaseId, download))
          completedEntities++;
        download = null;
      } catch (error) {
        failures++;
        const failure = classifyExchangeFailure(error);
        await this.phaseHealth(
          id,
          expectedRevision,
          entity.entityId,
          entity.kind,
          phase,
          'failure',
          options?.leaseId,
          failure.code,
        );
        lastError = {
          code: failure.code,
          phase,
          entityKey: exchangeEntityKey(entity),
          retryAfterMs: failure.retryAfterMs,
        };
        if (scope && download && failure.resetStaging)
          await this.downloads.discard(scope, download.id, leaseId).catch(() => undefined);
        const attempts =
          (schedule.find((s) => s.entity_id === entity.entityId && s.kind === entity.kind)
            ?.stats_failure_count ?? 0) + 1;
        const retryDelay = exchangeRetryDelay(failure, attempts);
        await this.prisma
          .$executeRaw`UPDATE statistics_exchange_entities e SET stats_error=${failure.code},stats_error_phase=${phase},
          stats_failure_count=LEAST(stats_failure_count+1,100),next_stats_at=now()+${retryDelay}*interval '1 millisecond',
          remote_valid_until=CASE WHEN ${failure.recheckAccess} THEN now() ELSE e.remote_valid_until END
          FROM statistics_exchange_grants g WHERE e.grant_id=g.id AND g.id=${id}::uuid AND g.revision=${expectedRevision}
            AND g.state='ACTIVE' AND e.entity_id=${entity.entityId} AND e.kind=${entity.kind}
            AND (${!options} OR (g.lease_id=${options?.leaseId ?? null}::uuid AND g.lease_until>now()))`;
        if (failure.recheckAccess)
          await this.prisma.$executeRaw`UPDATE statistics_exchange_grants
          SET next_remote_access_at=now() WHERE id=${id}::uuid AND revision=${expectedRevision}
            AND (${!options} OR (lease_id=${options?.leaseId ?? null}::uuid AND lease_until>now()))`;
        if (!options) throw error;
      } finally {
        if (scope && download)
          await this.downloads.release(scope, download.id, leaseId).catch(() => undefined);
      }
    }
    const nextCursor =
      last && due.some((entity) => exchangeEntityKey(entity) > last!) ? last : null;
    const pendingRows = await this.prisma.$queryRaw<
      Array<{ pending: boolean; next_at: Date | null }>
    >`
      SELECT EXISTS(SELECT 1 FROM statistics_exchange_downloads WHERE grant_id=${id}::uuid AND grant_revision=${expectedRevision}) AS pending,
        min(e.next_stats_at) AS next_at FROM statistics_exchange_entities e JOIN marketplace_bindings b ON b.id=e.binding_id
        WHERE e.grant_id=${id}::uuid AND e.remote_valid_until>now() AND ${marketplaceLocalGrantSql('b')}`;
    if (!lastError) {
      const unresolved = await this.prisma.$queryRaw<
        Array<{ entity_id: string; kind: string; stats_error: string; stats_error_phase: string }>
      >`
        SELECT entity_id,kind,stats_error,stats_error_phase FROM statistics_exchange_entities
        WHERE grant_id=${id}::uuid AND stats_error IS NOT NULL ORDER BY kind,entity_id LIMIT 1`;
      if (unresolved[0])
        lastError = {
          code: unresolved[0].stats_error,
          phase: unresolved[0].stats_error_phase,
          entityKey: exchangeEntityKey({
            entityId: unresolved[0].entity_id,
            kind: unresolved[0].kind,
          }),
          retryAfterMs: null,
        };
    }
    return {
      nextCursor,
      failures,
      pending: nextCursor !== null || pendingRows[0]?.pending === true,
      completedEntities,
      nextDelayMs: nextCursor
        ? 1000
        : Math.max(
            1000,
            Math.min(
              300000,
              (pendingRows[0]?.next_at?.getTime() ?? Date.now() + 300000) - Date.now(),
            ),
          ),
      lastError,
    };
  }

  async selected(id: string, entityId: string, kind: 'CHAT' | 'CHANNEL') {
    const native = await this.page(id, { entityId, kind });
    const allNative = await this.prisma.$queryRaw<
      StoredGeneration[]
    >`SELECT id,manifest,rows FROM statistics_exchange_generations WHERE id=${native.manifest.generationId}::uuid`;
    const imported = await this.prisma.$queryRaw<
      ImportedProjection[]
    >`SELECT p.manifest,p.rows FROM statistics_exchange_imports p JOIN statistics_exchange_entities e
      ON e.grant_id=p.grant_id AND e.entity_id=p.entity_id AND e.kind=p.kind
      WHERE p.grant_id=${id}::uuid AND p.grant_revision=${native.manifest.grantRevision} AND p.entity_id=${entityId} AND p.kind=${kind}
        AND p.remote_valid_until>now() AND e.remote_valid_until>now() AND e.remote_binding_id::text=p.manifest->>'bindingId'`;
    const current = await this.grants.binding(id, entityId, kind);
    if (Number(current.grant.revision) !== native.manifest.grantRevision)
      throw new ConflictException('Согласие изменилось');
    const importedBinding = imported[0]
      ? exchangeManifestSchema.parse(imported[0].manifest).bindingId
      : null;
    const proof = await this.prisma.$queryRaw<
      Array<{ id: string }>
    >`SELECT g.id FROM statistics_exchange_grants g
      JOIN statistics_exchange_entities e ON e.grant_id=g.id JOIN marketplace_bindings b ON b.id=e.binding_id
      WHERE g.id=${id}::uuid AND g.state='ACTIVE' AND g.revision=${native.manifest.grantRevision}
        AND e.entity_id=${entityId} AND e.kind=${kind} AND e.remote_valid_until>now()
        AND b.id=${current.binding.id}::uuid AND ${marketplaceLocalGrantSql('b')}
        AND (${importedBinding === null} OR (e.remote_binding_id::text=${importedBinding} AND EXISTS(
          SELECT 1 FROM statistics_exchange_imports p WHERE p.grant_id=g.id AND p.grant_revision=g.revision
            AND p.entity_id=e.entity_id AND p.kind=e.kind AND p.remote_valid_until>now()
            AND p.manifest->>'bindingId'=${importedBinding})))`;
    if (!proof[0]) throw new ConflictException('Доступ изменился');
    return exchangeSelectedStatisticsSchema.parse({
      grantId: id,
      grantRevision: native.manifest.grantRevision,
      entityId,
      kind,
      sources: [
        native.manifest,
        ...(imported[0] ? [exchangeManifestSchema.parse(imported[0].manifest)] : []),
      ],
      rows: selectExchangeMeasurements(
        storedRows.parse(allNative[0]!.rows),
        imported[0] ? retainedExchangeMeasurements(storedRows.parse(imported[0].rows)) : [],
      ),
      sync: {
        lastSuccessfulPullAt: current.grant.last_pull_at?.toISOString() ?? null,
        error: current.grant.last_error !== null,
      },
    });
  }
  async owner(actor: string, entityId: string, kind: 'CHAT' | 'CHANNEL') {
    if (!statisticsExchangeActorAllowed(this.config, actor)) return null;
    const grants = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT g.id FROM statistics_exchange_grants g JOIN statistics_exchange_entities e ON e.grant_id=g.id
      WHERE g.actor_user_id=${actor} AND g.state='ACTIVE' AND e.entity_id=${entityId} AND e.kind=${kind}`;
    if (!grants[0]) return null;
    return this.selected(grants[0].id, entityId, kind);
  }
}
