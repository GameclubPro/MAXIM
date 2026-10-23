import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  exchangeManifestSchema,
  exchangeSelectedStatisticsSchema,
  exchangeMeasurementSchema,
  exchangeGrantSchema,
  exchangeMetricSchema,
  exchangeMeasurementKey,
  exchangeEntityKey,
  validateExchangePage,
  type ExchangeManifest,
  type ExchangeMeasurement,
  type ExchangeStatisticsPage,
  type ExchangeGrant,
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly grants: StatisticsExchangeGrantsService,
    private readonly native: MarketplaceStatisticsService,
  ) {}

  async refreshRemoteAccess(id: string, expectedRevision: number): Promise<void> {
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
    >`UPDATE statistics_exchange_grants SET remote_access_version=remote_access_version+1
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
        .$executeRaw`UPDATE statistics_exchange_grants SET remote_access_error='REMOTE_ACCESS_UNAVAILABLE'
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
      if (!active[0]) throw new ConflictException('Согласие или проверка доступа изменились');
      await tx.$executeRaw`WITH confirmed AS MATERIALIZED(SELECT * FROM jsonb_to_recordset(${JSON.stringify(confirmed)}::jsonb) AS c(entity_id text,kind text,profile text,binding_id uuid,valid_until timestamptz)),
        scoped AS MATERIALIZED(SELECT e.entity_id,e.kind,c.binding_id,c.valid_until FROM statistics_exchange_entities e
          LEFT JOIN confirmed c ON c.entity_id=e.entity_id AND c.kind=e.kind AND c.profile=e.profile WHERE e.grant_id=${id}::uuid)
        UPDATE statistics_exchange_entities e SET remote_valid_until=COALESCE(s.valid_until,now()),remote_binding_id=s.binding_id
          FROM scoped s WHERE e.grant_id=${id}::uuid AND e.entity_id=s.entity_id AND e.kind=s.kind`;
      await tx.$executeRaw`UPDATE statistics_exchange_imports p SET remote_valid_until=CASE WHEN e.remote_binding_id::text=p.manifest->>'bindingId' THEN e.remote_valid_until ELSE now() END
        FROM statistics_exchange_entities e WHERE p.grant_id=${id}::uuid AND p.grant_revision=${expectedRevision} AND e.grant_id=p.grant_id AND e.entity_id=p.entity_id AND e.kind=p.kind`;
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
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // FLAG: The grant row serializes revocation, lease loss and generation publication.
      const locked = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM statistics_exchange_grants
        WHERE id=${manifest.grantId}::uuid AND state='ACTIVE' AND revision=${manifest.grantRevision}
          AND (${leaseId === undefined} OR (lease_id=${leaseId ?? null}::uuid AND lease_until>now())) FOR UPDATE`;
      if (!locked[0]) throw new ConflictException('Согласие или аренда изменились');
      const current = await tx.$queryRaw<
        Array<{ id: string; remote_valid_until: Date }>
      >`SELECT g.id,e.remote_valid_until FROM statistics_exchange_grants g
        JOIN statistics_exchange_entities e ON e.grant_id=g.id JOIN marketplace_bindings b ON b.id=e.binding_id
        WHERE g.id=${manifest.grantId}::uuid AND g.state='ACTIVE' AND g.revision=${manifest.grantRevision}
          AND e.entity_id=${manifest.entityId} AND e.kind=${manifest.kind} AND b.id=${bindingId}::uuid AND ${marketplaceLocalGrantSql('b')}
          AND e.remote_valid_until>now() AND (${manifest.origin === 'MAXIM'} OR e.remote_binding_id::text=${manifest.bindingId})
          AND (${leaseId === undefined} OR (g.lease_id=${leaseId ?? null}::uuid AND g.lease_until>now())) FOR UPDATE OF b`;
      if (!current[0]) throw new ConflictException('Согласие или аренда изменились');
      if (manifest.origin === 'EXCHANGE') {
        // FLAG: Immutable transport expiry must not erase the durable producer revision fence.
        const materialized = await tx.$queryRaw<Array<{ manifest: unknown }>>`
          SELECT manifest FROM statistics_exchange_imports WHERE grant_id=${manifest.grantId}::uuid
            AND grant_revision=${manifest.grantRevision} AND entity_id=${manifest.entityId} AND kind=${manifest.kind} FOR UPDATE`;
        if (materialized[0]) {
          const prior = exchangeManifestSchema.parse(materialized[0].manifest);
          if (prior.producerRevision > manifest.producerRevision) return;
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
          return;
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
        // FLAG: A correction replaces only its declared interval. Omitted rows inside are deletions;
        // rows outside retain their own producer revisions. Never rewrite the immutable checksum.
        const retained = previous[0]
          ? storedRows
              .parse(previous[0].rows)
              .filter(
                (row) =>
                  row.data.bucket >= cutoff &&
                  (row.data.bucket < manifest.from || row.data.bucket >= manifest.to),
              )
          : [];
        const merged = storedRows.parse(canonicalExchangeMeasurements([...retained, ...rows]));
        await tx.$executeRaw`INSERT INTO statistics_exchange_imports(grant_id,grant_revision,entity_id,kind,producer_revision,manifest,rows,remote_valid_until)
          VALUES(${manifest.grantId}::uuid,${manifest.grantRevision},${manifest.entityId},${manifest.kind},${manifest.producerRevision},${JSON.stringify(manifest)}::jsonb,${JSON.stringify(merged)}::jsonb,${current[0].remote_valid_until})
          ON CONFLICT(grant_id,grant_revision,entity_id,kind) DO UPDATE SET producer_revision=EXCLUDED.producer_revision,
            manifest=EXCLUDED.manifest,rows=EXCLUDED.rows,remote_valid_until=EXCLUDED.remote_valid_until,updated_at=now()`;
      }
    });
  }

  private async remote(path: string, deadline = Date.now() + 5000): Promise<unknown> {
    const token = this.config.get<string>('SVYAZKA_STATISTICS_EXPORT_TOKEN');
    if (!token) throw new Error('EXCHANGE_NOT_CONFIGURED');
    if (deadline <= Date.now()) throw new Error('EXCHANGE_DEADLINE');
    const response = await fetch(reverseBase + path, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(Math.min(5000, deadline - Date.now())),
    });
    if (!response.ok || !response.body) throw new Error('EXCHANGE_UNAVAILABLE');
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    const maximumBytes = /^\/grants\/[0-9a-f-]{36}$/u.test(path) ? 1024 * 1024 : 128 * 1024;
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

  async pull(
    id: string,
    expectedRevision: number,
    options?: {
      leaseId: string;
      afterEntityKey: string | null;
      maxEntities: number;
      deadline: number;
    },
  ): Promise<{ nextCursor: string | null; failures: number }> {
    const deadline = options?.deadline ?? Date.now() + 50_000;
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
    const eligible = local.entities
      .filter((value) => value.status === 'ACTIVE')
      .sort((a, b) => (exchangeEntityKey(a) < exchangeEntityKey(b) ? -1 : 1));
    const candidates = eligible
      .filter(
        (value) => !options?.afterEntityKey || exchangeEntityKey(value) > options.afterEntityKey,
      )
      .slice(0, options?.maxEntities ?? 100);
    let last: string | null = null,
      failures = 0;
    for (const entity of candidates) {
      if (Date.now() >= deadline - 1000) break;
      last = exchangeEntityKey(entity);
      try {
        const remoteEntity = remoteGrant.entities.find(
          (value) => value.entityId === entity.entityId && value.kind === entity.kind,
        );
        if (
          !remoteEntity ||
          remoteEntity.status !== 'ACTIVE' ||
          !remoteEntity.binding ||
          remoteEntity.binding.actorUserId !== local.actorUserId ||
          remoteEntity.binding.entityId !== entity.entityId ||
          remoteEntity.binding.kind !== entity.kind ||
          remoteEntity.binding.profile !== remoteEntity.profile
        ) {
          failures++;
          continue;
        }
        const { grant, binding } = await this.grants.binding(id, entity.entityId, entity.kind);
        if (
          options &&
          (grant.lease_id !== options.leaseId ||
            !grant.lease_until ||
            grant.lease_until.getTime() <= Date.now())
        )
          throw new ConflictException('Аренда изменилась');
        const rows: ExchangeMeasurement[] = [],
          keys = new Set<string>(),
          cursors = new Set<string>();
        let manifest: ExchangeManifest | undefined,
          cursor: string | null = null;
        do {
          const query = new URLSearchParams({ entityId: entity.entityId, kind: entity.kind });
          if (manifest) query.set('generationId', manifest.generationId);
          if (cursor) query.set('cursor', cursor);
          const page = validateExchangePage(
            await this.remote(`/grants/${encodeURIComponent(id)}/statistics?${query}`, deadline),
          );
          const m = page.manifest;
          if (
            m.origin !== 'EXCHANGE' ||
            m.grantId !== id ||
            m.grantRevision !== expectedRevision ||
            m.entityId !== entity.entityId ||
            m.kind !== entity.kind ||
            m.bindingId !== remoteEntity.binding.id ||
            (manifest && JSON.stringify(manifest) !== JSON.stringify(m))
          )
            throw new Error('EXCHANGE_IDENTITY_MISMATCH');
          manifest ??= m;
          for (const row of page.rows) {
            if (
              (entity.kind !== 'CHANNEL' ||
                (binding.metadata &&
                  marketplaceBindingMetadataSchema.parse(binding.metadata).isPublic !== true) ||
                remoteEntity.binding.metadata.isPublic !== true) &&
              (row.data.metric === 'REACH' || row.data.metric === 'PUBLICATION_HOUR')
            )
              throw new Error('EXCHANGE_METRIC_SCOPE_MISMATCH');
            const key = exchangeMeasurementKey(row);
            if (keys.has(key)) throw new Error('EXCHANGE_DUPLICATE_ROW');
            keys.add(key);
            rows.push(row);
          }
          if (rows.length > manifest.rowCount || rows.length > 3000)
            throw new Error('EXCHANGE_ROW_LIMIT');
          cursor = page.nextCursor;
          if (cursor) {
            if (cursors.has(cursor) || cursors.size >= 20) throw new Error('EXCHANGE_CURSOR_LOOP');
            cursors.add(cursor);
          }
        } while (cursor);
        if (
          !manifest ||
          rows.length !== manifest.rowCount ||
          exchangeMeasurementsHash(rows) !== manifest.sha256
        )
          throw new Error('EXCHANGE_CHECKSUM_MISMATCH');
        // FLAG: Confirm reverse consent again after all network work; local CAS fences late arrivals.
        const latest = await this.remoteGrant(id, expectedRevision, deadline);
        if (
          latest.state !== 'ACTIVE' ||
          latest.grantId !== id ||
          latest.actorUserId !== local.actorUserId ||
          latest.revision !== expectedRevision ||
          !latest.entities.some(
            (value) =>
              value.entityId === entity.entityId &&
              value.kind === entity.kind &&
              value.status === 'ACTIVE' &&
              value.binding?.id === manifest.bindingId &&
              value.binding.actorUserId === local.actorUserId &&
              value.binding.entityId === entity.entityId &&
              value.binding.kind === entity.kind &&
              value.binding.profile === value.profile,
          )
        )
          throw new ConflictException('Согласие изменилось');
        await this.store(
          manifest,
          canonicalExchangeMeasurements(rows),
          binding.id,
          options?.leaseId,
        );
      } catch (error) {
        failures++;
        if (!options) throw error;
      }
    }
    return {
      nextCursor:
        last && eligible.some((entity) => exchangeEntityKey(entity) > last!) ? last : null,
      failures,
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
