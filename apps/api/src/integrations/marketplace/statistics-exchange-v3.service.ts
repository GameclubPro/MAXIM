import { ConfigService } from '@nestjs/config';
import { centralEnabled, StatsFailure } from '../../statistics/stats-common';
import { ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  exchangeMeasurementSchema,
  exchangeV3ContentSchema,
  exchangeV3HeadSchema,
  exchangeV3StatisticsPageSchema,
  exchangeV3ScopeKey,
  exchangeV3ContentCanonical,
  type ExchangeMeasurement,
  type ExchangeV3Content,
  type ExchangeV3Head,
  type ExchangeV3StatisticsPage,
} from '@maxim/contracts';
import {
  marketplaceBindingMetadataSchema,
  marketplaceStatisticRowSchema,
  marketplaceStatisticsManifestSchema,
} from '@maxim/contracts/marketplace-integration';
import { PrismaService } from '../../prisma/prisma.service';
import { marketplaceLocalGrantSql, type MarketplaceBindingRow } from './marketplace-state.service';
import { StatisticsExchangeGrantsService } from './statistics-exchange-grants.service';
import { MarketplaceStatisticsService } from './marketplace-statistics.service';
import {
  canonicalExchangeMeasurements,
  exchangeMeasurementsHash,
  exchangeRetentionFrom,
} from './statistics-exchange-values';
import {
  exchangeV3Hash,
  exchangeV3NativeHealth,
  exchangeV3NativeMaterial,
  exchangeV3Scopes,
} from './statistics-exchange-v3-values';

const querySchema = z
  .object({
    entityId: z.string().regex(/^-[1-9]\d{0,19}$/u),
    kind: z.enum(['CHAT', 'CHANNEL']),
    knownContentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
  })
  .strict();
type Publication = {
  id: string;
  native_generation_id: string;
  context_hash: string;
  material_hash: string;
  content: unknown;
  scope_observations: unknown;
};
const observationsSchema = z.record(z.string(), z.string().datetime().nullable());

@Injectable()
export class StatisticsExchangeV3Service {
  constructor(
    private readonly prisma: PrismaService,
    private readonly grants: StatisticsExchangeGrantsService,
    private readonly native: MarketplaceStatisticsService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  private publicChannel(binding: MarketplaceBindingRow): boolean {
    return (
      binding.kind === 'CHANNEL' &&
      marketplaceBindingMetadataSchema.parse(binding.metadata).isPublic
    );
  }
  private context(binding: MarketplaceBindingRow, revision: number): string {
    return exchangeV3Hash({
      grantRevision: revision,
      bindingId: binding.id,
      entityId: binding.entity_id,
      kind: binding.kind,
      profile: binding.profile,
      botId: binding.bot_id,
      public: this.publicChannel(binding),
    });
  }
  async head(id: string, raw: unknown): Promise<ExchangeV3Head> {
    if (this.config && centralEnabled(this.config)) throw new StatsFailure('UNAVAILABLE', 410);
    const query = querySchema.parse(raw);
    let current = await this.grants.binding(id, query.entityId, query.kind);
    const cutoff = exchangeRetentionFrom();
    const prior = (
      await this.prisma.$queryRaw<Publication[]>`
      SELECT id,native_generation_id,context_hash,material_hash,content,scope_observations FROM statistics_exchange_v3_generations
      WHERE grant_id=${id}::uuid AND grant_revision=${current.grant.revision} AND kind=${query.kind} AND entity_id=${query.entityId}
      ORDER BY created_at DESC,id DESC LIMIT 1`
    )[0];
    let publication = prior;
    let content = prior ? exchangeV3ContentSchema.parse(prior.content) : null;
    // FLAG: The native collector publishes a stable generation pointer. Unchanged heads never rebuild history.
    if (
      !prior ||
      prior.native_generation_id !== current.binding.generation_id ||
      prior.context_hash !== this.context(current.binding, Number(current.grant.revision)) ||
      content!.from !== cutoff
    ) {
      let nativeId = current.binding.generation_id;
      if (nativeId) {
        const manifest = (
          await this.prisma.$queryRaw<
            Array<{ manifest: unknown }>
          >`SELECT manifest FROM marketplace_statistics_generations WHERE id=${nativeId}::uuid AND binding_id=${current.binding.id}::uuid`
        )[0];
        if (
          !manifest ||
          marketplaceStatisticsManifestSchema.parse(manifest.manifest).from !== cutoff
        )
          nativeId = null;
      }
      if (!nativeId) {
        nativeId = await this.native.createGeneration(current.binding);
        current = await this.grants.binding(id, query.entityId, query.kind);
      }
      publication = await this.publish(
        id,
        Number(current.grant.revision),
        current.binding,
        nativeId,
      );
      content = exchangeV3ContentSchema.parse(publication.content);
    }
    const final = await this.grants.binding(id, query.entityId, query.kind);
    if (
      Number(final.grant.revision) !== Number(current.grant.revision) ||
      publication!.context_hash !== this.context(final.binding, Number(final.grant.revision))
    )
      throw new ConflictException('EXCHANGE_DOWNLOAD_AUTHORITY_CHANGED');
    const access = (
      await this.prisma.$queryRaw<
        Array<{ access_revision: bigint; access_binding_revision: bigint }>
      >`SELECT g.access_revision,e.access_binding_revision FROM statistics_exchange_grants g JOIN statistics_exchange_entities e ON e.grant_id=g.id WHERE g.id=${id}::uuid AND g.revision=${final.grant.revision} AND g.state='ACTIVE' AND e.entity_id=${query.entityId} AND e.kind=${query.kind}`
    )[0];
    if (!access || !final.binding.checked_at || !final.binding.valid_until)
      throw new ConflictException('EXCHANGE_DOWNLOAD_AUTHORITY_CHANGED');
    return exchangeV3HeadSchema.parse({
      version: 3,
      grantId: id,
      grantRevision: Number(final.grant.revision),
      bindingId: final.binding.id,
      bindingRevision: Number(access.access_binding_revision),
      entityId: query.entityId,
      kind: query.kind,
      content,
      unchanged:
        query.knownContentHash !== undefined && query.knownContentHash === content?.contentHash,
      health: exchangeV3NativeHealth(
        exchangeV3Scopes(this.publicChannel(final.binding)),
        final.binding,
        observationsSchema.parse(publication!.scope_observations),
      ),
      access: {
        checkedAt: final.binding.checked_at.toISOString(),
        validUntil: final.binding.valid_until.toISOString(),
        accessRevision: Number(access.access_revision),
      },
    });
  }

  private async publish(
    id: string,
    revision: number,
    binding: MarketplaceBindingRow,
    nativeId: string,
  ): Promise<Publication> {
    const snapshot = (
      await this.prisma.$queryRaw<
        Array<{ manifest: unknown; rows: unknown }>
      >`SELECT manifest,rows FROM marketplace_statistics_generations WHERE id=${nativeId}::uuid AND binding_id=${binding.id}::uuid`
    )[0];
    if (!snapshot) throw new NotFoundException('EXCHANGE_NATIVE_NOT_READY');
    const source = marketplaceStatisticsManifestSchema.parse(snapshot.manifest);
    const scopes = exchangeV3Scopes(this.publicChannel(binding));
    const nativeRows = z
      .array(marketplaceStatisticRowSchema)
      .max(3000)
      .parse(snapshot.rows)
      .filter((data) => data.bucket >= source.from && data.bucket < source.to)
      .map(
        (data): ExchangeMeasurement => ({
          origin: 'MAXIM',
          method: 'utc-buckets-v1',
          revision: 0,
          data,
        }),
      );
    const material = exchangeV3NativeMaterial(nativeRows, source, binding, scopes);
    const contextHash = this.context(binding, revision);
    const fingerprint = exchangeV3Hash({
      contextHash,
      method: source.method,
      from: source.from,
      to: source.to,
      scopes: material.summaries,
      rows: canonicalExchangeMeasurements(material.rows),
    });
    const observations = Object.fromEntries(
      scopes.map((scope) => [
        exchangeV3ScopeKey(scope),
        material.rows
          .filter((r) => exchangeV3ScopeKey(r.data) === exchangeV3ScopeKey(scope))
          .reduce<
            string | null
          >((latest, r) => (r.data.observedAt && (!latest || r.data.observedAt > latest) ? r.data.observedAt : latest), null),
      ]),
    );
    return this.prisma.$transaction(
      async (tx) => {
        // FLAG: Only a fully prepared native snapshot is published under the final grant/binding/rights fence.
        const grants = await tx.$queryRaw<
          Array<{ producer_revision: bigint }>
        >`SELECT producer_revision FROM statistics_exchange_grants WHERE id=${id}::uuid AND revision=${revision} AND state='ACTIVE' FOR UPDATE`;
        const bindings = await tx.$queryRaw<
          MarketplaceBindingRow[]
        >`SELECT b.* FROM marketplace_bindings b JOIN statistics_exchange_entities e ON e.binding_id=b.id WHERE b.id=${binding.id}::uuid AND e.grant_id=${id}::uuid AND e.kind=${binding.kind} AND e.entity_id=${binding.entity_id} AND e.remote_valid_until>now() AND b.generation_id=${nativeId}::uuid AND ${marketplaceLocalGrantSql('b')} FOR UPDATE OF b`;
        if (!grants[0] || !bindings[0] || this.context(bindings[0], revision) !== contextHash)
          throw new ConflictException('EXCHANGE_DOWNLOAD_AUTHORITY_CHANGED');
        const previous = (
          await tx.$queryRaw<
            Publication[]
          >`SELECT id,native_generation_id,context_hash,material_hash,content,scope_observations FROM statistics_exchange_v3_generations WHERE grant_id=${id}::uuid AND grant_revision=${revision} AND kind=${binding.kind} AND entity_id=${binding.entity_id} ORDER BY created_at DESC,id DESC LIMIT 1`
        )[0];
        if (previous && previous.material_hash === fingerprint) return previous;
        const sequence = (
          await tx.$queryRaw<
            Array<{ producer_revision: bigint }>
          >`UPDATE statistics_exchange_grants SET producer_revision=producer_revision+1 WHERE id=${id}::uuid RETURNING producer_revision`
        )[0]!;
        const producerRevision = Number(sequence.producer_revision);
        const generationId = randomUUID();
        const rows = canonicalExchangeMeasurements(
          material.rows.map((row) => ({ ...row, revision: producerRevision })),
        );
        const pages: ExchangeMeasurement[][] = [];
        for (const row of rows) {
          let page = pages.at(-1);
          if (
            !page ||
            page.length >= 200 ||
            Buffer.byteLength(
              JSON.stringify({
                version: 3,
                generationId,
                contentHash: fingerprint,
                pageIndex: pages.length - 1,
                rows: [...page, row],
                nextPageIndex: pages.length,
              }),
            ) >
              128 * 1024
          ) {
            page = [];
            pages.push(page);
          }
          page.push(row);
        }
        const header = {
          generationId,
          contentHash: fingerprint,
          producerRevision,
          origin: 'MAXIM' as const,
          method: source.method,
          from: source.from,
          to: source.to,
          asOf: source.asOf,
          rowCount: rows.length,
          pageCount: pages.length,
          sha256: exchangeMeasurementsHash(rows),
          scopes: material.summaries,
          horizonToleranceSeconds: 900 as const,
        };
        const content: ExchangeV3Content = exchangeV3ContentSchema.parse({
          ...header,
          contentHash: createHash('sha256')
            .update(exchangeV3ContentCanonical(header))
            .digest('hex'),
        });
        await tx.$executeRaw`INSERT INTO statistics_exchange_v3_generations(id,grant_id,grant_revision,entity_id,kind,binding_id,native_generation_id,content_hash,material_hash,context_hash,content,scope_observations,retention_from) VALUES(${generationId}::uuid,${id}::uuid,${revision},${binding.entity_id},${binding.kind},${binding.id}::uuid,${nativeId}::uuid,${content.contentHash},${fingerprint},${contextHash},${JSON.stringify(content)}::jsonb,${JSON.stringify(observations)}::jsonb,${new Date(content.from)})`;
        for (const [pageIndex, items] of pages.entries()) {
          const payload = exchangeV3StatisticsPageSchema.parse({
            version: 3,
            generationId,
            contentHash: content.contentHash,
            pageIndex,
            rows: items,
            nextPageIndex: pageIndex + 1 < pages.length ? pageIndex + 1 : null,
          });
          const text = JSON.stringify(payload.rows);
          await tx.$executeRaw`INSERT INTO statistics_exchange_v3_generation_pages(generation_id,page_index,rows_text,row_count,byte_length,sha256) VALUES(${generationId}::uuid,${pageIndex},${text},${items.length},${Buffer.byteLength(text)},${exchangeV3Hash(items)})`;
        }
        return {
          id: generationId,
          native_generation_id: nativeId,
          context_hash: contextHash,
          material_hash: fingerprint,
          content,
          scope_observations: observations,
        };
      },
      { timeout: 20000 },
    );
  }

  async page(
    id: string,
    generation: string,
    index: number | string,
    raw: unknown,
  ): Promise<ExchangeV3StatisticsPage> {
    if (this.config && centralEnabled(this.config)) throw new StatsFailure('UNAVAILABLE', 410);
    const query = querySchema.omit({ knownContentHash: true }).parse(raw);
    const generationId = z.string().uuid().parse(generation),
      pageIndex = z.coerce.number().int().min(0).max(19).parse(index);
    const { grant, binding } = await this.grants.binding(id, query.entityId, query.kind);
    // FLAG: The indexed page join never fetches the native/legacy aggregate blob.
    const page = (
      await this.prisma.$queryRaw<
        Array<{ content: unknown; context_hash: string; rows_text: string }>
      >`
      SELECT g.content,g.context_hash,p.rows_text FROM statistics_exchange_v3_generations g
      JOIN statistics_exchange_v3_generation_pages p ON p.generation_id=g.id AND p.page_index=${pageIndex}
      WHERE g.id=${generationId}::uuid AND g.grant_id=${id}::uuid AND g.grant_revision=${grant.revision}
        AND g.kind=${query.kind} AND g.entity_id=${query.entityId} AND g.binding_id=${binding.id}::uuid
        AND g.retention_from>=${new Date(exchangeRetentionFrom())}`
    )[0];
    if (!page || page.context_hash !== this.context(binding, Number(grant.revision)))
      throw new NotFoundException('EXCHANGE_GENERATION_UNAVAILABLE');
    const content = exchangeV3ContentSchema.parse(page.content);
    const rows = z.array(exchangeMeasurementSchema).max(200).parse(JSON.parse(page.rows_text));
    const final = await this.grants.binding(id, query.entityId, query.kind);
    if (
      Number(final.grant.revision) !== Number(grant.revision) ||
      this.context(final.binding, Number(final.grant.revision)) !== page.context_hash
    )
      throw new ConflictException('EXCHANGE_DOWNLOAD_AUTHORITY_CHANGED');
    return exchangeV3StatisticsPageSchema.parse({
      version: 3,
      generationId,
      contentHash: content.contentHash,
      pageIndex,
      rows,
      nextPageIndex: pageIndex + 1 < content.pageCount ? pageIndex + 1 : null,
    });
  }
}
