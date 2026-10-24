import { ConflictException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  exchangeManifestSchema,
  exchangeV3HeadSchema,
  exchangeMeasurementSchema,
  exchangeMeasurementIdentity,
  type ExchangeManifest,
  type ExchangeMeasurement,
  type ExchangeStatisticsPage,
} from '@maxim/contracts';
import { z } from 'zod';
import { Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { marketplaceLocalGrantSql } from './marketplace-state.service';

export type ExchangeDownloadScope = {
  grantId: string;
  grantRevision: number;
  entityId: string;
  kind: 'CHAT' | 'CHANNEL';
  localBindingId: string;
  remoteBindingId: string;
  grantLeaseId?: string;
  v3Head?: unknown;
};
export type ExchangeDownload = {
  id: string;
  grant_id: string;
  grant_revision: bigint;
  entity_id: string;
  kind: 'CHAT' | 'CHANNEL';
  local_binding_id: string;
  remote_binding_id: string;
  generation_id: string;
  manifest: unknown;
  v3_head?: unknown;
  next_cursor: string | null;
  page_count: number;
  received_rows: number;
  received_bytes: number;
  state: 'DOWNLOADING' | 'READY';
  lease_id: string | null;
  expires_at: Date;
};
type DownloadPage = {
  page_ordinal: number;
  request_cursor: string | null;
  next_cursor: string | null;
  rows_text: string;
  row_count: number;
  byte_count: number;
  rows_sha256: string;
};
const measurements = z.array(exchangeMeasurementSchema).max(3000);

@Injectable()
export class StatisticsExchangeDownloadsService {
  constructor(private readonly prisma: PrismaService) {}

  private async guard(tx: Prisma.TransactionClient, scope: ExchangeDownloadScope) {
    // FLAG: Every staging write follows the same grant-first lock order as activation/revocation.
    const grants = await tx.$queryRaw<
      Array<{ id: string; lease_id: string | null; leased: boolean }>
    >`
      SELECT id,lease_id,(lease_until>now()) AS leased FROM statistics_exchange_grants WHERE id=${scope.grantId}::uuid
        AND revision=${scope.grantRevision} AND state='ACTIVE' FOR UPDATE`;
    if (!grants[0]) throw new ConflictException('EXCHANGE_DOWNLOAD_AUTHORITY_CHANGED');
    if (
      scope.grantLeaseId !== undefined &&
      (grants[0].lease_id !== scope.grantLeaseId || grants[0].leased !== true)
    )
      throw new ConflictException('EXCHANGE_DOWNLOAD_LEASE_CHANGED');
    const bindings = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT e.grant_id AS id FROM statistics_exchange_entities e JOIN marketplace_bindings b ON b.id=e.binding_id
      WHERE e.grant_id=${scope.grantId}::uuid AND e.entity_id=${scope.entityId} AND e.kind=${scope.kind}
        AND b.id=${scope.localBindingId}::uuid AND ${marketplaceLocalGrantSql('b')}
        AND e.remote_binding_id=${scope.remoteBindingId}::uuid AND e.remote_valid_until>now() FOR UPDATE OF e,b`;
    if (!bindings[0]) throw new ConflictException('EXCHANGE_DOWNLOAD_AUTHORITY_CHANGED');
  }

  async claim(scope: ExchangeDownloadScope, leaseId: string): Promise<ExchangeDownload | null> {
    return this.prisma.$transaction(async (tx) => {
      await this.guard(tx, scope);
      await tx.$executeRaw`DELETE FROM statistics_exchange_downloads
        WHERE grant_id=${scope.grantId}::uuid AND entity_id=${scope.entityId} AND kind=${scope.kind}
          AND (grant_revision<>${scope.grantRevision} OR local_binding_id<>${scope.localBindingId}::uuid
            OR remote_binding_id<>${scope.remoteBindingId}::uuid OR expires_at<=now())`;
      const rows = await tx.$queryRaw<ExchangeDownload[]>`
        UPDATE statistics_exchange_downloads SET lease_id=${leaseId}::uuid,
          lease_until=now()+interval '30 seconds',updated_at=now()
        WHERE grant_id=${scope.grantId}::uuid AND grant_revision=${scope.grantRevision}
          AND entity_id=${scope.entityId} AND kind=${scope.kind}
          AND (lease_id=${leaseId}::uuid OR lease_until IS NULL OR lease_until<=now()) RETURNING *`;
      if (rows[0]) return rows[0];
      const busy = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM statistics_exchange_downloads WHERE grant_id=${scope.grantId}::uuid
          AND grant_revision=${scope.grantRevision} AND entity_id=${scope.entityId} AND kind=${scope.kind}`;
      if (busy[0]) throw new ConflictException('EXCHANGE_DOWNLOAD_LEASE_BUSY');
      return null;
    });
  }

  async append(
    scope: ExchangeDownloadScope,
    leaseId: string,
    previous: ExchangeDownload | null,
    page: ExchangeStatisticsPage,
  ): Promise<ExchangeDownload> {
    const manifest = exchangeManifestSchema.parse(page.manifest);
    if (
      manifest.origin !== 'EXCHANGE' ||
      manifest.grantId !== scope.grantId ||
      manifest.grantRevision !== scope.grantRevision ||
      manifest.entityId !== scope.entityId ||
      manifest.kind !== scope.kind ||
      manifest.bindingId !== scope.remoteBindingId
    )
      throw new Error('EXCHANGE_IDENTITY_MISMATCH');
    // FLAG: Keep producer order and contractual JSON representation until checksum verification.
    const rowsText = JSON.stringify(page.rows);
    const bytes = Buffer.byteLength(rowsText);
    const hash = createHash('sha256').update(rowsText).digest('hex');
    if (bytes > 128 * 1024) throw new Error('EXCHANGE_RESPONSE_LIMIT');
    return this.prisma.$transaction(async (tx) => {
      await this.guard(tx, scope);
      let current = (
        await tx.$queryRaw<ExchangeDownload[]>`
        SELECT * FROM statistics_exchange_downloads WHERE grant_id=${scope.grantId}::uuid
          AND grant_revision=${scope.grantRevision} AND entity_id=${scope.entityId} AND kind=${scope.kind} FOR UPDATE`
      )[0];
      if (!current) {
        if (previous) throw new ConflictException('EXCHANGE_DOWNLOAD_CHANGED');
        const expiresAt = new Date(
          Math.min(
            Date.now() + 86400000,
            Math.floor(Date.parse(manifest.from) / 86400000) * 86400000 + 90 * 86400000,
          ),
        );
        if (expiresAt.getTime() <= Date.now()) throw new Error('EXCHANGE_DOWNLOAD_EXPIRED');
        current = (
          await tx.$queryRaw<ExchangeDownload[]>`
          INSERT INTO statistics_exchange_downloads(id,grant_id,grant_revision,entity_id,kind,local_binding_id,
            remote_binding_id,generation_id,producer_revision,manifest,v3_head,lease_id,lease_until,expires_at)
          VALUES(${randomUUID()}::uuid,${scope.grantId}::uuid,${scope.grantRevision},${scope.entityId},${scope.kind},
            ${scope.localBindingId}::uuid,${scope.remoteBindingId}::uuid,${manifest.generationId}::uuid,
            ${manifest.producerRevision},${JSON.stringify(manifest)}::jsonb,${scope.v3Head === undefined ? null : JSON.stringify(scope.v3Head)}::jsonb,${leaseId}::uuid,now()+interval '30 seconds',${expiresAt}) RETURNING *`
        )[0]!;
      }
      if (
        (previous && current.id !== previous.id) ||
        current.lease_id !== leaseId ||
        current.local_binding_id !== scope.localBindingId ||
        current.remote_binding_id !== scope.remoteBindingId ||
        JSON.stringify(exchangeManifestSchema.parse(current.manifest)) !==
          JSON.stringify(manifest) ||
        (scope.v3Head !== undefined &&
          JSON.stringify(exchangeV3HeadSchema.parse(current.v3_head)) !==
            JSON.stringify(exchangeV3HeadSchema.parse(scope.v3Head)))
      )
        throw new ConflictException('EXCHANGE_DOWNLOAD_CHANGED');
      const owned = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM statistics_exchange_downloads WHERE id=${current.id}::uuid
          AND lease_id=${leaseId}::uuid AND lease_until>now() AND expires_at>now()`;
      if (!owned[0]) throw new ConflictException('EXCHANGE_DOWNLOAD_LEASE_CHANGED');
      const ordinal = previous?.page_count ?? 0;
      const requestCursor = previous?.next_cursor ?? null;
      const prior = (
        await tx.$queryRaw<DownloadPage[]>`
        SELECT * FROM statistics_exchange_download_pages WHERE download_id=${current.id}::uuid AND page_ordinal=${ordinal}`
      )[0];
      if (prior) {
        if (
          prior.request_cursor !== requestCursor ||
          prior.next_cursor !== page.nextCursor ||
          prior.rows_sha256 !== hash ||
          prior.rows_text !== rowsText
        )
          throw new Error('EXCHANGE_PAGE_CONFLICT');
        return current;
      }
      if (
        current.state !== 'DOWNLOADING' ||
        current.page_count !== ordinal ||
        current.next_cursor !== requestCursor
      )
        throw new ConflictException('EXCHANGE_DOWNLOAD_CURSOR_CHANGED');
      if (
        current.page_count >= 20 ||
        current.received_rows + page.rows.length > manifest.rowCount ||
        current.received_rows + page.rows.length > 3000 ||
        current.received_bytes + bytes > 2621440
      )
        throw new Error('EXCHANGE_ROW_LIMIT');
      if (page.nextCursor !== null) {
        const loop = await tx.$queryRaw<Array<{ page_ordinal: number }>>`
          SELECT page_ordinal FROM statistics_exchange_download_pages WHERE download_id=${current.id}::uuid
            AND (request_cursor=${page.nextCursor} OR next_cursor=${page.nextCursor}) LIMIT 1`;
        if (page.nextCursor === requestCursor || loop[0] || current.page_count === 19)
          throw new Error('EXCHANGE_CURSOR_LOOP');
      }
      await tx.$executeRaw`INSERT INTO statistics_exchange_download_pages(download_id,page_ordinal,request_cursor,next_cursor,
        rows_text,rows_sha256,row_count,byte_count) VALUES(${current.id}::uuid,${ordinal},${requestCursor},${page.nextCursor},
        ${rowsText},${hash},${page.rows.length},${bytes})`;
      return (
        await tx.$queryRaw<ExchangeDownload[]>`
        UPDATE statistics_exchange_downloads SET next_cursor=${page.nextCursor},page_count=page_count+1,
          received_rows=received_rows+${page.rows.length},received_bytes=received_bytes+${bytes},
          state=${page.nextCursor === null ? 'READY' : 'DOWNLOADING'},last_page_at=now(),updated_at=now()
        WHERE id=${current.id}::uuid RETURNING *`
      )[0]!;
    });
  }

  async assemble(
    download: ExchangeDownload,
  ): Promise<{ manifest: ExchangeManifest; rows: ExchangeMeasurement[] }> {
    const manifest = exchangeManifestSchema.parse(download.manifest);
    const pages = await this.prisma.$queryRaw<DownloadPage[]>`
      SELECT * FROM statistics_exchange_download_pages WHERE download_id=${download.id}::uuid ORDER BY page_ordinal LIMIT 21`;
    if (download.state !== 'READY' || pages.length !== download.page_count || pages.length > 20)
      throw new Error('EXCHANGE_PAGE_SEQUENCE');
    const rows: ExchangeMeasurement[] = [];
    const keys = new Set<string>();
    let bytes = 0,
      cursor: string | null = null;
    for (const [ordinal, page] of pages.entries()) {
      if (
        page.page_ordinal !== ordinal ||
        page.request_cursor !== cursor ||
        createHash('sha256').update(page.rows_text).digest('hex') !== page.rows_sha256 ||
        Buffer.byteLength(page.rows_text) !== page.byte_count
      )
        throw new Error('EXCHANGE_PAGE_SEQUENCE');
      const items = measurements.parse(JSON.parse(page.rows_text));
      if (items.length !== page.row_count) throw new Error('EXCHANGE_PAGE_SEQUENCE');
      for (const row of items) {
        const key = exchangeMeasurementIdentity(row);
        if (keys.has(key)) throw new Error('EXCHANGE_DUPLICATE_ROW');
        keys.add(key);
        rows.push(row);
      }
      bytes += page.byte_count;
      cursor = page.next_cursor;
    }
    if (
      cursor !== null ||
      rows.length !== manifest.rowCount ||
      rows.length !== download.received_rows ||
      bytes !== download.received_bytes ||
      bytes > 2621440 ||
      createHash('sha256').update(JSON.stringify(rows)).digest('hex') !== manifest.sha256
    )
      throw new Error('EXCHANGE_CHECKSUM_MISMATCH');
    return { manifest, rows };
  }

  async release(scope: ExchangeDownloadScope, downloadId: string, leaseId: string): Promise<void> {
    await this.prisma
      .$executeRaw`UPDATE statistics_exchange_downloads SET lease_id=NULL,lease_until=NULL
      WHERE id=${downloadId}::uuid AND grant_id=${scope.grantId}::uuid AND grant_revision=${scope.grantRevision} AND lease_id=${leaseId}::uuid`;
  }
  async discard(scope: ExchangeDownloadScope, downloadId: string, leaseId: string): Promise<void> {
    await this.prisma
      .$executeRaw`DELETE FROM statistics_exchange_downloads WHERE id=${downloadId}::uuid
      AND grant_id=${scope.grantId}::uuid AND grant_revision=${scope.grantRevision} AND lease_id=${leaseId}::uuid`;
  }
  async consume(
    tx: Prisma.TransactionClient,
    download: ExchangeDownload,
    successful: boolean,
  ): Promise<void> {
    // FLAG: READY consumption and visible activation commit together; an old finalizer cannot publish.
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      DELETE FROM statistics_exchange_downloads WHERE id=${download.id}::uuid AND state='READY'
        AND generation_id=${download.generation_id}::uuid AND lease_id=${download.lease_id}::uuid
        AND lease_until>now() AND expires_at>now() RETURNING id`;
    if (!rows[0]) throw new ConflictException('EXCHANGE_DOWNLOAD_LEASE_CHANGED');
    await tx.$executeRaw`UPDATE statistics_exchange_entities SET
      last_stats_at=CASE WHEN ${successful} THEN now() ELSE last_stats_at END,
      stats_error=NULL,stats_error_phase=NULL,stats_failure_count=0,next_stats_at=now()+interval '5 minutes',
      stats_phase_health=jsonb_set(stats_phase_health,ARRAY['ACTIVATE'],
        COALESCE(stats_phase_health->'ACTIVATE','{}'::jsonb)||jsonb_build_object('successAt',now(),'error',NULL))
      WHERE grant_id=${download.grant_id}::uuid AND entity_id=${download.entity_id} AND kind=${download.kind}`;
  }
}
