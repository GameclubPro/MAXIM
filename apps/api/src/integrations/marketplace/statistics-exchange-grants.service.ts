import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { marketplaceBindingMetadataSchema } from '@maxim/contracts/marketplace-integration';
import {
  exchangeEntitiesPageSchema,
  exchangeEntityKey,
  exchangeGrantInputSchema,
  exchangeGrantSchema,
  type ExchangeEntityKey,
  type ExchangeGrant,
} from '@maxim/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '../../prisma/prisma-client';
import {
  type ExchangeV3GrantInput,
  type ExchangeV3MembershipManifest,
} from '@maxim/contracts/statistics-exchange-v3';
import { MarketplaceAccessService } from './marketplace-access.service';
import {
  MarketplaceStateService,
  marketplaceLocalGrantSql,
  type MarketplaceBindingRow,
} from './marketplace-state.service';
import { statisticsExchangeActorAllowed } from './statistics-exchange.settings';

export type StatisticsExchangeGrantRow = {
  id: string;
  actor_user_id: string;
  revision: bigint;
  state: 'ACTIVE' | 'REVOKED';
  input_hash: string;
  lease_id: string | null;
  lease_until: Date | null;
  pull_cursor: string | null;
  last_pull_at: Date | null;
  last_error: string | null;
  failure_count: number;
};
const grantId = z.string().uuid();
const discoveryQuery = z
  .object({
    actorUserId: z.string().regex(/^[1-9]\d{0,19}$/u),
    cursor: z.string().max(2048).optional(),
  })
  .strict();

// FLAG: Both v2 discovery and immutable v3 snapshots use the same exact actor/bot policy.
function statisticsExchangeRosterCandidatesSql(actor: string): Prisma.Sql {
  return Prisma.sql`
      SELECT DISTINCT a.chat_id AS "entityId",c.entity_type::text AS kind,
        CASE WHEN p.publisher_bot_id=a.bot_id THEN 'publisher' ELSE 'moderation' END AS profile,
        c.title,a.checked_at AS "checkedAt",b.metadata,
        c.entity_type::text||':'||a.chat_id||':'||CASE WHEN p.publisher_bot_id=a.bot_id THEN 'publisher' ELSE 'moderation' END AS cursor
      FROM managed_entity_access_edges a JOIN chats c ON c.id=a.chat_id
      LEFT JOIN chat_bot_memberships m ON m.chat_id=a.chat_id AND m.bot_id=a.bot_id AND m.status='ACTIVE'
      LEFT JOIN publisher_entity_bindings p ON p.chat_id=a.chat_id AND p.publisher_bot_id=a.bot_id AND p.status='ACTIVE'
      LEFT JOIN marketplace_bindings b ON b.actor_user_id=a.user_id AND b.entity_id=a.chat_id AND b.bot_id=a.bot_id
        AND b.profile=CASE WHEN p.publisher_bot_id=a.bot_id THEN 'publisher' ELSE 'moderation' END
      WHERE a.user_id=${actor} AND a.state='GRANTED' AND a.user_role IN ('OWNER','ADMIN') AND a.bot_role IN ('OWNER','ADMIN')
        AND (m.chat_id IS NOT NULL OR p.chat_id IS NOT NULL)`;
}

@Injectable()
export class StatisticsExchangeGrantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly access: MarketplaceAccessService,
    private readonly state: MarketplaceStateService,
  ) {}

  assertActor(actor: string): void {
    if (!statisticsExchangeActorAllowed(this.config, actor))
      throw new ForbiddenException('Обмен статистикой пока недоступен');
  }

  async discover(raw: unknown) {
    const query = discoveryQuery.parse(raw);
    this.assertActor(query.actorUserId);
    // FLAG: Candidate identity is exact actor/bot/profile SQL authority, never a bot-wide MAX scan.
    const candidates = await this.prisma.$queryRaw<
      Array<
        ExchangeEntityKey & { cursor: string; title: string; checkedAt: Date; metadata: unknown }
      >
    >`SELECT * FROM (${statisticsExchangeRosterCandidatesSql(query.actorUserId)}) candidates
       WHERE cursor>${query.cursor ?? ''} ORDER BY cursor LIMIT 101`;
    const entities = [];
    const seen = new Set<string>();
    for (const candidate of candidates.slice(0, 100)) {
      if (seen.has(exchangeEntityKey(candidate))) continue;
      {
        // Discovery is a local candidate list; only the later fresh binding grants exchange access.
        const existing = marketplaceBindingMetadataSchema.safeParse(candidate.metadata);
        const metadata = existing.success
          ? existing.data
          : {
              title: candidate.title.slice(0, 300),
              description: '',
              imageUrl: null,
              publicUrl: null,
              audience: null,
              isPublic: false,
            };
        seen.add(exchangeEntityKey(candidate));
        entities.push({
          entityId: candidate.entityId,
          kind: candidate.kind,
          profile: candidate.profile,
          metadata,
          capabilities:
            candidate.kind === 'CHANNEL' && metadata.isPublic === true
              ? ['AUDIENCE', 'MEMBERSHIP', 'REACH', 'PUBLICATION_HOUR']
              : ['AUDIENCE', 'MEMBERSHIP'],
          checkedAt: candidate.checkedAt.toISOString(),
        });
      }
    }
    return exchangeEntitiesPageSchema.parse({
      entities,
      nextCursor: candidates.length > 100 ? candidates[99]!.cursor : null,
    });
  }

  async row(id: string): Promise<StatisticsExchangeGrantRow | null> {
    const rows = await this.prisma.$queryRaw<
      StatisticsExchangeGrantRow[]
    >`SELECT * FROM statistics_exchange_grants WHERE id=${grantId.parse(id)}::uuid`;
    return rows[0] ?? null;
  }

  async read(id: string): Promise<ExchangeGrant> {
    const grant = await this.row(id);
    if (!grant) throw new NotFoundException('Согласие не найдено');
    // FLAG: One bounded snapshot applies the exact same local authority gate to every binding.
    const rows = await this.prisma.$queryRaw<
      Array<
        MarketplaceBindingRow & {
          exchange_entity_id: string;
          exchange_kind: 'CHAT' | 'CHANNEL';
          exchange_profile: 'moderation' | 'publisher';
          exchange_error: string | null;
          local_active: boolean | null;
        }
      >
    >`
      SELECT e.entity_id AS exchange_entity_id,e.kind AS exchange_kind,e.profile AS exchange_profile,e.error AS exchange_error,
        b.*,(${marketplaceLocalGrantSql('b')}) AS local_active
      FROM statistics_exchange_entities e LEFT JOIN marketplace_bindings b ON b.id=e.binding_id
      WHERE e.grant_id=${grant.id}::uuid ORDER BY e.kind,e.entity_id LIMIT 101`;
    if (rows.length > 100) throw new ConflictException('ROSTER_REQUIRES_V3');
    const actorAllowed = statisticsExchangeActorAllowed(this.config, grant.actor_user_id);
    const entities = rows.map((row) => {
      const binding = row.id ? row : null;
      const active =
        grant.state === 'ACTIVE' && actorAllowed && binding !== null && row.local_active === true;
      return {
        entityId: row.exchange_entity_id,
        kind: row.exchange_kind,
        profile: row.exchange_profile,
        status: grant.state === 'REVOKED' ? 'REVOKED' : active ? 'ACTIVE' : 'UNAVAILABLE',
        binding: binding ? this.state.present(binding) : null,
        error: active ? null : (row.exchange_error ?? 'ACCESS_UNAVAILABLE'),
      };
    });
    return exchangeGrantSchema.parse({
      grantId: grant.id,
      actorUserId: grant.actor_user_id,
      revision: Number(grant.revision),
      state: grant.state,
      entities,
    });
  }

  async put(id: string, raw: unknown): Promise<ExchangeGrant> {
    const input = exchangeGrantInputSchema.parse(raw);
    if (grantId.parse(id) !== input.grantId)
      throw new ConflictException('Идентификатор согласия не совпадает');
    if (input.state === 'ACTIVE') this.assertActor(input.actorUserId);
    const canonical = {
      ...input,
      entities: [...input.entities].sort((a, b) =>
        exchangeEntityKey(a).localeCompare(exchangeEntityKey(b)),
      ),
    };
    const hash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
    const previous = await this.row(input.grantId);
    if (previous && Number(previous.revision) === input.revision) {
      if (previous.actor_user_id !== input.actorUserId || previous.input_hash !== hash)
        throw new ConflictException('Версия согласия уже использована');
      return this.read(input.grantId);
    }
    if (
      previous &&
      (previous.actor_user_id !== input.actorUserId || Number(previous.revision) > input.revision)
    )
      throw new ConflictException('Версия согласия устарела');
    const bindings: Array<{ entity: ExchangeEntityKey; binding: MarketplaceBindingRow | null }> =
      [];
    for (const entity of input.entities) {
      let binding: MarketplaceBindingRow | null = null;
      if (input.state === 'ACTIVE') {
        const known = await this.prisma.$queryRaw<
          MarketplaceBindingRow[]
        >`SELECT * FROM marketplace_bindings WHERE actor_user_id=${input.actorUserId} AND entity_id=${entity.entityId} AND kind=${entity.kind} AND profile=${entity.profile}`;
        if (known[0] && (await this.state.hasActiveAccess(known[0].id))) binding = known[0];
      }
      bindings.push({ entity, binding });
    }
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'statistics-exchange-grant:' + input.actorUserId},0))`;
        const locked = await tx.$queryRaw<
          StatisticsExchangeGrantRow[]
        >`SELECT * FROM statistics_exchange_grants WHERE actor_user_id=${input.actorUserId} FOR UPDATE`;
        const current = locked[0];
        if (
          current &&
          (current.id !== input.grantId ||
            Number(current.revision) > input.revision ||
            (Number(current.revision) === input.revision && current.input_hash !== hash))
        )
          throw new ConflictException('Согласие изменилось');
        if (current && Number(current.revision) === input.revision) return;
        // FLAG: Revoke only collection enabled by v2. Independent v1 consent survives removal.
        await tx.$executeRaw`UPDATE marketplace_bindings b SET statistics_consent=false,statistics_v2_consent_only=false,lease_id=NULL,lease_until=NULL,revision=revision+1,updated_at=now()
        WHERE b.statistics_v2_consent_only=true AND b.id IN(SELECT binding_id FROM statistics_exchange_entities WHERE grant_id=${input.grantId}::uuid)`;
        await tx.$executeRaw`INSERT INTO statistics_exchange_grants(id,actor_user_id,revision,state,input_hash)
        VALUES(${input.grantId}::uuid,${input.actorUserId},${input.revision},${input.state},${hash})
        ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,state=EXCLUDED.state,input_hash=EXCLUDED.input_hash,updated_at=now(),next_pull_at=now(),lease_id=NULL,lease_until=NULL,pull_cursor=NULL`;
        await tx.$executeRaw`DELETE FROM statistics_exchange_entities WHERE grant_id=${input.grantId}::uuid`;
        await tx.$executeRaw`DELETE FROM statistics_exchange_imports WHERE grant_id=${input.grantId}::uuid AND grant_revision<>${input.revision}`;
        for (const { entity, binding } of bindings) {
          if (binding && input.state === 'ACTIVE') {
            await tx.$executeRaw`UPDATE marketplace_bindings SET statistics_v2_consent_only=CASE WHEN statistics_consent=false THEN true ELSE statistics_v2_consent_only END,
            statistics_consent=true,next_collect_at=now(),revision=revision+1,updated_at=now()
            WHERE id=${binding.id}::uuid AND statistics_revoked_at IS NULL
              AND ${marketplaceLocalGrantSql('marketplace_bindings', false)} AND checked_at=${binding.checked_at}`;
          }
          // FLAG: An authenticated new server selection supplies only bounded initial peer proof.
          // Replaying the same revision above never extends this deadline.
          await tx.$executeRaw`INSERT INTO statistics_exchange_entities(grant_id,entity_id,kind,profile,binding_id,error,remote_valid_until)
          VALUES(${input.grantId}::uuid,${entity.entityId},${entity.kind},${entity.profile},${binding?.id ?? null}::uuid,${binding ? null : 'ACCESS_UNAVAILABLE'},CASE WHEN ${input.state === 'ACTIVE'} THEN now()+interval '5 minutes' ELSE NULL END)`;
        }
      },
      { timeout: 20_000 },
    );
    return this.read(input.grantId);
  }

  async snapshotRoster(tx: Prisma.TransactionClient, actor: string): Promise<ExchangeEntityKey[]> {
    this.assertActor(actor);
    return tx.$queryRaw<ExchangeEntityKey[]>`
      SELECT DISTINCT ON (kind COLLATE "C","entityId" COLLATE "C") "entityId",kind,profile
      FROM (${statisticsExchangeRosterCandidatesSql(actor)}) candidates
      ORDER BY kind COLLATE "C","entityId" COLLATE "C",profile COLLATE "C" LIMIT 10001`;
  }

  async applyVerifiedSnapshot(
    tx: Prisma.TransactionClient,
    input: ExchangeV3GrantInput,
    entities: ExchangeEntityKey[],
    manifest: ExchangeV3MembershipManifest | null,
    hash: string,
  ): Promise<void> {
    const locked = await tx.$queryRaw<StatisticsExchangeGrantRow[]>`
      SELECT * FROM statistics_exchange_grants WHERE actor_user_id=${input.actorUserId} FOR UPDATE`;
    const current = locked[0];
    if (current && (current.id !== input.grantId || current.actor_user_id !== input.actorUserId))
      throw new ConflictException('EXCHANGE_IDENTITY_MISMATCH');
    if (current && Number(current.revision) === input.revision) {
      if (current.input_hash !== hash) throw new ConflictException('EXCHANGE_REVISION_CONFLICT');
      return;
    }
    if (Number(current?.revision ?? 0) !== input.expectedRevision)
      throw new ConflictException('EXCHANGE_REVISION_CONFLICT');
    // FLAG: Revocation removes only consent introduced by this integration; independent grants survive.
    await tx.$executeRaw`UPDATE marketplace_bindings b SET statistics_consent=false,
      statistics_v2_consent_only=false,lease_id=NULL,lease_until=NULL,revision=revision+1,updated_at=now()
      WHERE b.statistics_v2_consent_only=true AND b.id IN
        (SELECT binding_id FROM statistics_exchange_entities WHERE grant_id=${input.grantId}::uuid)`;
    await tx.$executeRaw`INSERT INTO statistics_exchange_grants
      (id,actor_user_id,revision,state,input_hash,membership_snapshot_id,membership_revision,membership_sha256,membership_entity_count,access_revision)
      VALUES(${input.grantId}::uuid,${input.actorUserId},${input.revision},${input.state},${hash},
        ${manifest?.snapshotId ?? null}::uuid,${manifest?.membershipRevision ?? 0},${manifest?.sha256 ?? null},${entities.length},1)
      ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,state=EXCLUDED.state,input_hash=EXCLUDED.input_hash,
        membership_snapshot_id=EXCLUDED.membership_snapshot_id,membership_revision=EXCLUDED.membership_revision,
        membership_sha256=EXCLUDED.membership_sha256,membership_entity_count=EXCLUDED.membership_entity_count,
        access_revision=statistics_exchange_grants.access_revision+1,updated_at=now(),next_pull_at=now(),
        lease_id=NULL,lease_until=NULL,pull_cursor=NULL,remote_access_cursor=NULL,remote_access_revision=NULL,
        remote_access_sweep_id=NULL,remote_access_sweep_started_at=NULL`;
    await tx.$executeRaw`DELETE FROM statistics_exchange_entities WHERE grant_id=${input.grantId}::uuid`;
    await tx.$executeRaw`DELETE FROM statistics_exchange_imports WHERE grant_id=${input.grantId}::uuid AND grant_revision<>${input.revision}`;
    if (input.state !== 'ACTIVE') return;
    const selected = JSON.stringify(entities);
    await tx.$executeRaw`UPDATE marketplace_bindings b SET statistics_v2_consent_only=CASE WHEN statistics_consent=false THEN true ELSE statistics_v2_consent_only END,
      statistics_consent=true,next_collect_at=now(),revision=revision+1,updated_at=now()
      FROM jsonb_to_recordset(${selected}::jsonb) e("entityId" text,kind text,profile text)
      WHERE b.actor_user_id=${input.actorUserId} AND b.entity_id=e."entityId" AND b.kind=e.kind AND b.profile=e.profile
        AND b.statistics_revoked_at IS NULL AND ${marketplaceLocalGrantSql('b', false)}`;
    // FLAG: Initial authenticated peer proof is bounded; replaying the same revision never reaches this write.
    await tx.$executeRaw`INSERT INTO statistics_exchange_entities
      (grant_id,entity_id,kind,profile,binding_id,error,remote_valid_until)
      SELECT ${input.grantId}::uuid,e."entityId",e.kind,e.profile,b.id,
        CASE WHEN b.id IS NULL THEN 'ACCESS_UNAVAILABLE' ELSE NULL END,now()+interval '5 minutes'
      FROM jsonb_to_recordset(${selected}::jsonb) e("entityId" text,kind text,profile text)
      LEFT JOIN marketplace_bindings b ON b.actor_user_id=${input.actorUserId} AND b.entity_id=e."entityId"
        AND b.kind=e.kind AND b.profile=e.profile AND ${marketplaceLocalGrantSql('b')}`;
  }

  async recoverUnavailable(id: string): Promise<boolean> {
    const grant = await this.row(id);
    if (!grant || grant.state !== 'ACTIVE') return false;
    this.assertActor(grant.actor_user_id);
    const rows = await this.prisma.$queryRaw<
      ExchangeEntityKey[]
    >`UPDATE statistics_exchange_entities SET next_check_at=now()+interval '1 minute'
      WHERE (grant_id,entity_id,kind) IN(SELECT grant_id,entity_id,kind FROM statistics_exchange_entities
        WHERE grant_id=${id}::uuid AND binding_id IS NULL AND next_check_at<=now()
        ORDER BY next_check_at,entity_id,kind FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING entity_id AS "entityId",kind,profile`;
    const entity = rows[0];
    if (!entity) {
      const pending = await this.prisma.$queryRaw<
        Array<{ entity_id: string }>
      >`SELECT entity_id FROM statistics_exchange_entities WHERE grant_id=${id}::uuid AND binding_id IS NULL LIMIT 1`;
      return pending.length > 0;
    }
    const binding = await this.access.attest({ actorUserId: grant.actor_user_id, ...entity }, true);
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.$queryRaw<
        StatisticsExchangeGrantRow[]
      >`SELECT * FROM statistics_exchange_grants WHERE id=${id}::uuid FOR UPDATE`;
      if (!current[0] || current[0].state !== 'ACTIVE' || current[0].revision !== grant.revision)
        return;
      const active = await this.state.hasActiveAccess(binding.id);
      if (!active) return;
      const enabled =
        await tx.$executeRaw`UPDATE marketplace_bindings SET statistics_v2_consent_only=CASE WHEN statistics_consent=false THEN true ELSE statistics_v2_consent_only END,statistics_consent=true,next_collect_at=now(),revision=revision+1 WHERE id=${binding.id}::uuid
        AND statistics_revoked_at IS NULL AND ${marketplaceLocalGrantSql('marketplace_bindings', false)}`;
      if (!enabled) return;
      await tx.$executeRaw`UPDATE statistics_exchange_entities SET binding_id=${binding.id}::uuid,error=NULL WHERE grant_id=${id}::uuid AND entity_id=${entity.entityId} AND kind=${entity.kind}`;
    });
    const pending = await this.prisma.$queryRaw<Array<{ entity_id: string }>>`
      SELECT entity_id FROM statistics_exchange_entities WHERE grant_id=${id}::uuid AND binding_id IS NULL LIMIT 1`;
    return pending.length > 0;
  }

  async binding(
    id: string,
    entityId: string,
    kind: string,
  ): Promise<{ grant: StatisticsExchangeGrantRow; binding: MarketplaceBindingRow }> {
    const grant = await this.row(id);
    if (!grant || grant.state !== 'ACTIVE') throw new NotFoundException('Обмен отключён');
    this.assertActor(grant.actor_user_id);
    const entities = await this.prisma.$queryRaw<
      Array<{ binding_id: string | null }>
    >`SELECT binding_id FROM statistics_exchange_entities WHERE grant_id=${grant.id}::uuid AND entity_id=${entityId} AND kind=${kind} AND remote_valid_until>now()`;
    const binding = entities[0]?.binding_id ? await this.state.read(entities[0].binding_id) : null;
    if (!binding || !(await this.state.hasActiveGrant(binding.id)))
      throw new ForbiddenException('Доступ к площадке изменился');
    return { grant, binding };
  }
}
