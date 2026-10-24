import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
  HttpException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  EXCHANGE_V3_CAPABILITIES,
  EXCHANGE_V3_COMPACT_PAGE_BYTES,
  EXCHANGE_V3_MEMBERSHIP_PAGE_SIZE,
  exchangeV3AccessPageSchema,
  exchangeV3AccessQuerySchema,
  exchangeV3CompareEntities,
  exchangeV3EnvelopeBytes,
  exchangeV3GrantHeaderSchema,
  exchangeV3GrantInputSchema,
  exchangeV3MembershipCanonical,
  exchangeV3MembershipPageSchema,
  exchangeV3MembershipStatusSchema,
  exchangeV3MetadataResponseSchema,
  exchangeV3MetadataSchema,
  exchangeV3SnapshotRequestSchema,
  type ExchangeV3AccessEntity,
  type ExchangeV3GrantHeader,
  type ExchangeV3MembershipManifest,
  type ExchangeV3MembershipPage,
  type ExchangeV3Scope,
} from '@maxim/contracts/statistics-exchange-v3';
import {
  exchangeEntityKey,
  exchangeEntityKeySchema,
  type ExchangeEntityKey,
} from '@maxim/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '../../prisma/prisma-client';
import { StatisticsExchangeGrantsService } from './statistics-exchange-grants.service';

const uuid = z.string().uuid();
const SNAPSHOT_MS = 15 * 60_000;
const SNAPSHOT_ENTITY_BUDGET = 10_000;
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const membershipReference = (v: SnapshotRow): ExchangeV3MembershipManifest => ({
  version: 3,
  snapshotId: v.id,
  actorUserId: v.actor_user_id,
  membershipRevision: Number(v.membership_revision),
  entityCount: v.entity_count,
  pageCount: v.page_count,
  sha256: v.sha256,
  createdAt: v.created_at.toISOString(),
  expiresAt: v.expires_at.toISOString(),
});
type SnapshotRow = {
  id: string;
  actor_user_id: string;
  request_id: string;
  membership_revision: bigint;
  sha256: string;
  entity_count: number;
  page_count: number;
  created_at: Date;
  expires_at: Date;
};
type HeaderRow = {
  id: string;
  actor_user_id: string;
  revision: bigint;
  state: 'ACTIVE' | 'REVOKED';
  input_hash: string;
  membership_snapshot_id: string | null;
  membership_revision: bigint;
  membership_sha256: string | null;
  membership_entity_count: number;
  access_revision: bigint;
};
type AccessRow = {
  entityId: string;
  kind: 'CHANNEL' | 'CHAT';
  profile: 'moderation' | 'publisher';
  bindingId: string | null;
  bindingRevision: number;
  checkedAt: Date | null;
  validUntil: Date | null;
  active: boolean;
  metadata: unknown;
  botId: string | null;
};

@Injectable()
export class StatisticsExchangeV3MembershipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly grants: StatisticsExchangeGrantsService,
  ) {}

  assertEnabled(): void {
    if (!this.config.get<boolean>('STATISTICS_EXCHANGE_V3_ENABLED'))
      throw new NotFoundException('EXCHANGE_VERSION_UNSUPPORTED');
  }
  capabilities() {
    this.assertEnabled();
    return EXCHANGE_V3_CAPABILITIES;
  }
  private async lock(tx: Prisma.TransactionClient, actor: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'statistics-exchange-grant:' + actor},0))`;
  }
  private async roster(tx: Prisma.TransactionClient, actor: string) {
    const entities = (await this.grants.snapshotRoster(tx, actor))
      .map((e) => exchangeEntityKeySchema.parse(e))
      .sort(exchangeV3CompareEntities);
    if (entities.length > SNAPSHOT_ENTITY_BUDGET)
      throw new HttpException('EXCHANGE_MEMBERSHIP_BUDGET', 429);
    if (new Set(entities.map(exchangeEntityKey)).size !== entities.length)
      throw new ConflictException('EXCHANGE_DUPLICATE_ROW');
    const sha256 = hash(exchangeV3MembershipCanonical(entities));
    const counters = await tx.$queryRaw<Array<{ revision: bigint }>>`
      INSERT INTO statistics_exchange_membership_actors(actor_user_id,revision,sha256)
      VALUES(${actor},1,${sha256}) ON CONFLICT(actor_user_id) DO UPDATE SET
        revision=CASE WHEN statistics_exchange_membership_actors.sha256<>EXCLUDED.sha256 THEN statistics_exchange_membership_actors.revision+1 ELSE statistics_exchange_membership_actors.revision END,
        sha256=EXCLUDED.sha256,updated_at=CASE WHEN statistics_exchange_membership_actors.sha256<>EXCLUDED.sha256 THEN now() ELSE statistics_exchange_membership_actors.updated_at END
      RETURNING revision`;
    return { entities, sha256, revision: Number(counters[0]!.revision) };
  }
  async snapshot(raw: unknown) {
    this.assertEnabled();
    const input = exchangeV3SnapshotRequestSchema.parse(raw);
    this.grants.assertActor(input.actorUserId);
    const result = await this.prisma.$transaction(
      async (tx) => {
        await this.lock(tx, input.actorUserId);
        const existing = await tx.$queryRaw<
          SnapshotRow[]
        >`SELECT * FROM statistics_exchange_membership_snapshots WHERE actor_user_id=${input.actorUserId} AND request_id=${input.requestId}::uuid`;
        if (existing[0]) {
          if (existing[0].expires_at.getTime() <= Date.now())
            throw new GoneException('EXCHANGE_SNAPSHOT_EXPIRED');
          return membershipReference(existing[0]);
        }
        const roster = await this.roster(tx, input.actorUserId);
        const snapshotId = randomUUID(),
          createdAt = new Date(),
          expiresAt = new Date(createdAt.getTime() + SNAPSHOT_MS);
        const pages: ExchangeV3MembershipPage[] = [];
        let entries: ExchangeEntityKey[] = [];
        const emit = () => {
          if (!entries.length) return;
          pages.push({
            version: 3,
            snapshotId,
            membershipRevision: roster.revision,
            pageIndex: pages.length,
            entities: entries,
            nextPageIndex: pages.length + 1,
          });
          entries = [];
        };
        for (const entity of roster.entities) {
          const envelope = {
            version: 3,
            snapshotId,
            membershipRevision: roster.revision,
            pageIndex: pages.length,
            entities: [...entries, entity],
            nextPageIndex: pages.length + 1,
          };
          if (
            entries.length &&
            (entries.length === EXCHANGE_V3_MEMBERSHIP_PAGE_SIZE ||
              exchangeV3EnvelopeBytes(envelope) > EXCHANGE_V3_COMPACT_PAGE_BYTES)
          )
            emit();
          entries.push(entity);
          if (
            exchangeV3EnvelopeBytes({ ...envelope, entities: entries }) >
            EXCHANGE_V3_COMPACT_PAGE_BYTES
          )
            throw new ConflictException('EXCHANGE_RESPONSE_LIMIT');
        }
        emit();
        if (pages.length) pages[pages.length - 1]!.nextPageIndex = null;
        const manifest: ExchangeV3MembershipManifest = {
          version: 3,
          snapshotId,
          actorUserId: input.actorUserId,
          membershipRevision: roster.revision,
          entityCount: roster.entities.length,
          pageCount: pages.length,
          sha256: roster.sha256,
          createdAt: createdAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
        };
        await tx.$executeRaw`INSERT INTO statistics_exchange_membership_snapshots(id,actor_user_id,request_id,membership_revision,sha256,entity_count,page_count,created_at,expires_at)
        VALUES(${snapshotId}::uuid,${input.actorUserId},${input.requestId}::uuid,${roster.revision},${roster.sha256},${roster.entities.length},${pages.length},${createdAt},${expiresAt})`;
        for (let offset = 0; offset < roster.entities.length; offset += 500) {
          const batch = roster.entities
            .slice(offset, offset + 500)
            .map((e, i) => ({ ...e, ordinal: offset + i }));
          await tx.$executeRaw`INSERT INTO statistics_exchange_membership_snapshot_entities(snapshot_id,ordinal,entity_id,kind,profile)
          SELECT ${snapshotId}::uuid,e.ordinal,e."entityId",e.kind,e.profile FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) e(ordinal int,"entityId" text,kind text,profile text)`;
        }
        for (const page of pages) {
          const verified = exchangeV3MembershipPageSchema.parse(page);
          await tx.$executeRaw`INSERT INTO statistics_exchange_membership_snapshot_pages(snapshot_id,page_index,payload,byte_length)
          VALUES(${snapshotId}::uuid,${page.pageIndex},${JSON.stringify(verified)}::jsonb,${exchangeV3EnvelopeBytes(verified)})`;
        }
        return manifest;
      },
      { timeout: 20_000 },
    );
    return exchangeV3MembershipStatusSchema.parse({
      version: 3,
      state: 'READY',
      snapshotId: result.snapshotId,
      manifest: result,
    });
  }
  private async snapshotRow(id: string): Promise<SnapshotRow> {
    const rows = await this.prisma.$queryRaw<
      SnapshotRow[]
    >`SELECT * FROM statistics_exchange_membership_snapshots WHERE id=${uuid.parse(id)}::uuid`;
    const row = rows[0];
    if (!row) throw new NotFoundException('EXCHANGE_SNAPSHOT_EXPIRED');
    this.grants.assertActor(row.actor_user_id);
    if (row.expires_at.getTime() <= Date.now())
      throw new GoneException('EXCHANGE_SNAPSHOT_EXPIRED');
    return row;
  }
  async snapshotStatus(id: string) {
    this.assertEnabled();
    const row = await this.snapshotRow(id);
    return exchangeV3MembershipStatusSchema.parse({
      version: 3,
      state: 'READY',
      snapshotId: row.id,
      manifest: membershipReference(row),
    });
  }
  async snapshotPage(id: string, index: unknown) {
    this.assertEnabled();
    const row = await this.snapshotRow(id),
      pageIndex = z.coerce.number().int().nonnegative().safe().parse(index);
    if (pageIndex >= row.page_count) throw new NotFoundException('EXCHANGE_PAGE_NOT_FOUND');
    const pages = await this.prisma.$queryRaw<
      Array<{ payload: unknown }>
    >`SELECT payload FROM statistics_exchange_membership_snapshot_pages WHERE snapshot_id=${row.id}::uuid AND page_index=${pageIndex}`;
    if (!pages[0]) throw new NotFoundException('EXCHANGE_PAGE_NOT_FOUND');
    return exchangeV3MembershipPageSchema.parse(pages[0].payload);
  }
  private async headerRow(
    id: string,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<HeaderRow> {
    const rows = await tx.$queryRaw<
      HeaderRow[]
    >`SELECT id,actor_user_id,revision,state,input_hash,membership_snapshot_id,membership_revision,membership_sha256,membership_entity_count,access_revision FROM statistics_exchange_grants WHERE id=${uuid.parse(id)}::uuid`;
    if (!rows[0]) throw new NotFoundException('EXCHANGE_GRANT_NOT_FOUND');
    return rows[0];
  }
  private presentHeader(row: HeaderRow): ExchangeV3GrantHeader {
    return exchangeV3GrantHeaderSchema.parse({
      version: 3,
      grantId: row.id,
      actorUserId: row.actor_user_id,
      revision: Number(row.revision),
      state: row.state,
      membership:
        row.membership_snapshot_id && row.membership_sha256
          ? {
              snapshotId: row.membership_snapshot_id,
              membershipRevision: Number(row.membership_revision),
              sha256: row.membership_sha256,
              entityCount: row.membership_entity_count,
            }
          : null,
      accessRevision: Number(row.access_revision),
    });
  }
  async read(id: string) {
    this.assertEnabled();
    const row = await this.headerRow(id);
    if (row.state === 'ACTIVE') this.grants.assertActor(row.actor_user_id);
    return this.presentHeader(row);
  }
  async put(id: string, raw: unknown) {
    this.assertEnabled();
    const input = exchangeV3GrantInputSchema.parse(raw);
    if (uuid.parse(id) !== input.grantId) throw new ConflictException('EXCHANGE_IDENTITY_MISMATCH');
    if (input.state === 'ACTIVE') this.grants.assertActor(input.actorUserId);
    const inputHash = hash(JSON.stringify(input));
    await this.prisma.$transaction(
      async (tx) => {
        await this.lock(tx, input.actorUserId);
        const previous = await tx.$queryRaw<
          Array<{ revision: bigint; input_hash: string; actor_user_id: string }>
        >`SELECT revision,input_hash,actor_user_id FROM statistics_exchange_grants WHERE id=${input.grantId}::uuid FOR UPDATE`;
        if (previous[0] && Number(previous[0].revision) === input.revision) {
          if (
            previous[0].actor_user_id !== input.actorUserId ||
            previous[0].input_hash !== inputHash
          )
            throw new ConflictException('EXCHANGE_REVISION_CONFLICT');
          return;
        }
        let manifest: ExchangeV3MembershipManifest | null = null;
        let entities: ExchangeEntityKey[] = [];
        if (input.state === 'ACTIVE') {
          const reference = input.membershipSnapshot!;
          const snapshots = await tx.$queryRaw<
            SnapshotRow[]
          >`SELECT * FROM statistics_exchange_membership_snapshots WHERE id=${reference.snapshotId}::uuid`;
          const snapshot = snapshots[0];
          if (!snapshot || snapshot.expires_at.getTime() <= Date.now())
            throw new GoneException('EXCHANGE_SNAPSHOT_EXPIRED');
          if (
            snapshot.actor_user_id !== input.actorUserId ||
            Number(snapshot.membership_revision) !== reference.membershipRevision ||
            snapshot.sha256 !== reference.sha256
          )
            throw new ConflictException('EXCHANGE_IDENTITY_MISMATCH');
          const current = await this.roster(tx, input.actorUserId);
          if (
            current.revision !== reference.membershipRevision ||
            current.sha256 !== reference.sha256
          )
            throw new ConflictException('EXCHANGE_REVISION_CONFLICT');
          const rows = await tx.$queryRaw<
            ExchangeEntityKey[]
          >`SELECT entity_id AS "entityId",kind,profile FROM statistics_exchange_membership_snapshot_entities WHERE snapshot_id=${snapshot.id}::uuid ORDER BY ordinal`;
          entities = rows.map((e) => exchangeEntityKeySchema.parse(e));
          if (
            entities.length !== snapshot.entity_count ||
            hash(exchangeV3MembershipCanonical(entities)) !== snapshot.sha256
          )
            throw new ConflictException('EXCHANGE_CHECKSUM_MISMATCH');
          manifest = membershipReference(snapshot);
        }
        await this.grants.applyVerifiedSnapshot(tx, input, entities, manifest, inputHash);
      },
      { timeout: 20_000 },
    );
    return this.read(input.grantId);
  }
  async access(id: string, rawQuery: unknown) {
    this.assertEnabled();
    const query = exchangeV3AccessQuerySchema.parse(rawQuery),
      grant = await this.headerRow(id);
    if (grant.state === 'ACTIVE') this.grants.assertActor(grant.actor_user_id);
    let after = '';
    if (query.cursor !== undefined) {
      try {
        const decoded = z
          .object({
            grantId: uuid,
            revision: z.number().int().nonnegative().safe(),
            accessRevision: z.number().int().nonnegative().safe(),
            after: z.string().max(100),
          })
          .strict()
          .parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')));
        if (
          decoded.grantId !== grant.id ||
          decoded.revision !== Number(grant.revision) ||
          decoded.accessRevision !== Number(grant.access_revision)
        )
          throw new Error('Invalid cursor context');
        after = decoded.after;
      } catch {
        throw new ConflictException('EXCHANGE_REVISION_CONFLICT');
      }
    }
    const limit = query.entityId === undefined ? 101 : 1;
    const rows = await this.prisma.$queryRaw<AccessRow[]>`
      SELECT e.entity_id AS "entityId",e.kind,e.profile,b.id AS "bindingId",coalesce(b.revision,0) AS "bindingRevision",
        b.checked_at AS "checkedAt",b.valid_until AS "validUntil",b.metadata,b.bot_id AS "botId",
        coalesce((${grant.state === 'ACTIVE'} AND ${this.grants.localGrantSql('b')}),false) AS active
      FROM (SELECT entity_id,kind,profile,binding_id FROM statistics_exchange_entities
        WHERE grant_id=${grant.id}::uuid
          AND (${query.entityId !== undefined} OR (kind||':'||entity_id) COLLATE "C">${after})
          AND (${query.entityId === undefined} OR (entity_id=${query.entityId ?? ''} AND kind=${query.kind ?? ''}))
        ORDER BY (kind||':'||entity_id) COLLATE "C" LIMIT ${limit}) e
      LEFT JOIN marketplace_bindings b ON b.id=e.binding_id ORDER BY (e.kind||':'||e.entity_id) COLLATE "C"`;
    const entities: ExchangeV3AccessEntity[] = [];
    let hasMore = false;
    for (const row of rows) {
      if (entities.length === 100) {
        hasMore = true;
        break;
      }
      const metadata = exchangeV3MetadataSchema.safeParse(row.metadata);
      const isPublic =
        typeof row.metadata === 'object' &&
        row.metadata !== null &&
        !Array.isArray(row.metadata) &&
        (row.metadata as { isPublic?: unknown }).isPublic === true;
      const scopes: ExchangeV3Scope[] = row.active
        ? [{ metric: 'AUDIENCE' }, { metric: 'MEMBERSHIP' }]
        : [];
      if (row.active && row.kind === 'CHANNEL' && isPublic)
        scopes.push(
          { metric: 'PUBLICATION_HOUR' },
          { metric: 'REACH', horizon: 0 },
          { metric: 'REACH', horizon: 24 },
          { metric: 'REACH', horizon: 48 },
        );
      const lease = this.grants.accessLease(row.checkedAt, row.validUntil, row.active);
      const record: ExchangeV3AccessEntity = {
        entityId: row.entityId,
        kind: row.kind,
        profile: row.profile,
        bindingId: row.bindingId,
        bindingRevision: Number(row.bindingRevision),
        status: grant.state === 'REVOKED' ? 'REVOKED' : row.active ? 'ACTIVE' : 'UNAVAILABLE',
        checkedAt: lease.checkedAt?.toISOString() ?? null,
        validUntil: lease.validUntil?.toISOString() ?? null,
        permittedScopes: scopes,
        isPublic,
        errorCode: row.active ? null : 'ACCESS_UNAVAILABLE',
        metadataVersion: metadata.success ? hash(JSON.stringify(metadata.data)) : null,
      };
      const safe = record;
      const candidate = [...entities, safe];
      const cursor = Buffer.from(
        JSON.stringify({
          grantId: grant.id,
          revision: Number(grant.revision),
          accessRevision: Number(grant.access_revision),
          after: exchangeEntityKey(safe),
        }),
      ).toString('base64url');
      if (
        entities.length &&
        exchangeV3EnvelopeBytes({
          version: 3,
          grantId: grant.id,
          grantRevision: Number(grant.revision),
          accessRevision: Number(grant.access_revision),
          entities: candidate,
          nextCursor: cursor,
        }) > EXCHANGE_V3_COMPACT_PAGE_BYTES
      ) {
        hasMore = true;
        break;
      }
      entities.push(safe);
    }
    if (grant.state === 'ACTIVE')
      await this.grants.requestAccess(
        grant.id,
        Number(grant.revision),
        rows.slice(0, entities.length),
      );
    const bots = new Map(rows.map((r) => [exchangeEntityKey(r), r.botId]));
    const signatures = entities.map((e) => ({
      entityId: e.entityId,
      kind: e.kind,
      signature: hash(
        JSON.stringify({
          status: e.status,
          bindingId: e.bindingId,
          profile: e.profile,
          botId: bots.get(exchangeEntityKey(e)) ?? null,
          scopes: e.permittedScopes,
          isPublic: e.isPublic,
        }),
      ),
    }));
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM statistics_exchange_grants WHERE id=${id}::uuid FOR UPDATE`;
      const locked = await this.headerRow(id, tx);
      if (
        locked.revision !== grant.revision ||
        locked.access_revision !== grant.access_revision ||
        locked.state !== grant.state
      )
        throw new ConflictException('EXCHANGE_REVISION_CONFLICT');
      const changes = await tx.$queryRaw<Array<{ changed: boolean }>>`
        SELECT EXISTS(SELECT 1 FROM statistics_exchange_entities e JOIN jsonb_to_recordset(${JSON.stringify(signatures)}::jsonb) s("entityId" text,kind text,signature text)
          ON e.entity_id=s."entityId" AND e.kind=s.kind WHERE e.grant_id=${id}::uuid AND e.access_signature IS NOT NULL AND e.access_signature<>s.signature) AS changed`;
      await tx.$executeRaw`UPDATE statistics_exchange_entities e SET access_binding_revision=CASE
          WHEN e.access_signature IS NULL THEN 1 ELSE e.access_binding_revision+1 END,access_signature=s.signature
        FROM jsonb_to_recordset(${JSON.stringify(signatures)}::jsonb) s("entityId" text,kind text,signature text)
        WHERE e.grant_id=${id}::uuid AND e.entity_id=s."entityId" AND e.kind=s.kind AND e.access_signature IS DISTINCT FROM s.signature`;
      if (changes[0]?.changed)
        await tx.$executeRaw`UPDATE statistics_exchange_grants SET access_revision=access_revision+1 WHERE id=${id}::uuid`;
      const versions = await tx.$queryRaw<
        Array<{ entity_id: string; kind: string; access_binding_revision: bigint }>
      >`
      SELECT e.entity_id,e.kind,e.access_binding_revision FROM statistics_exchange_entities e
      JOIN jsonb_to_recordset(${JSON.stringify(signatures)}::jsonb) s("entityId" text,kind text)
        ON e.entity_id=s."entityId" AND e.kind=s.kind
      WHERE e.grant_id=${id}::uuid`;

      return { ...(await this.headerRow(id, tx)), versions };
    });
    if (query.cursor !== undefined && updated.access_revision !== grant.access_revision)
      throw new ConflictException('EXCHANGE_REVISION_CONFLICT');
    const byKey = new Map(
      updated.versions.map((v) => [v.kind + ':' + v.entity_id, Number(v.access_binding_revision)]),
    );
    for (const entity of entities)
      entity.bindingRevision = byKey.get(exchangeEntityKey(entity)) ?? 0;
    const nextCursor = hasMore
      ? Buffer.from(
          JSON.stringify({
            grantId: grant.id,
            revision: Number(grant.revision),
            accessRevision: Number(updated.access_revision),
            after: exchangeEntityKey(entities[entities.length - 1]!),
          }),
        ).toString('base64url')
      : null;
    return exchangeV3AccessPageSchema.parse({
      version: 3,
      grantId: grant.id,
      grantRevision: Number(grant.revision),
      accessRevision: Number(updated.access_revision),
      entities,
      nextCursor,
    });
  }
  async exactAccess(
    id: string,
    kind: 'CHANNEL' | 'CHAT',
    entityId: string,
  ): Promise<ExchangeV3AccessEntity | null> {
    const page = await this.access(id, { kind, entityId });
    return page.entities[0] ?? null;
  }
  async metadata(id: string, kind: string, entityId: string, rawQuery: unknown) {
    this.assertEnabled();
    const key = exchangeEntityKeySchema.parse({ kind, entityId, profile: 'moderation' });
    const query = z
      .object({
        knownVersion: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .optional(),
      })
      .strict()
      .parse(rawQuery);
    const access = await this.exactAccess(id, key.kind, key.entityId);
    if (!access || access.status !== 'ACTIVE' || !access.bindingId)
      throw new ForbiddenException('EXCHANGE_ACCESS_DENIED');
    const rows = await this.prisma.$queryRaw<
      Array<{ metadata: unknown }>
    >`SELECT b.metadata FROM marketplace_bindings b
      JOIN statistics_exchange_entities e ON e.binding_id=b.id AND e.grant_id=${id}::uuid
      JOIN statistics_exchange_grants g ON g.id=e.grant_id AND g.state='ACTIVE'
      WHERE b.id=${access.bindingId}::uuid AND e.access_binding_revision=${access.bindingRevision} AND ${this.grants.localGrantSql('b')}`;
    if (!rows[0]) throw new ForbiddenException('EXCHANGE_ACCESS_DENIED');
    const metadata = exchangeV3MetadataSchema.parse(rows[0].metadata),
      metadataVersion = hash(JSON.stringify(metadata));
    return exchangeV3MetadataResponseSchema.parse({
      version: 3,
      metadataVersion,
      changed: query.knownVersion !== metadataVersion,
      metadata: query.knownVersion === metadataVersion ? null : metadata,
    });
  }
}
