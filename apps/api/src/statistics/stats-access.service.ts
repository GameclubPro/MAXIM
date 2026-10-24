import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  StatsAuthorityRequest,
  StatsAuthorityResult,
  StatsEntity,
  StatsMetricKey,
  StatsReadContext,
  StatsSourceDependency,
  StatsAuthorityRef,
} from '@maxim/contracts/statistics-central';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  allKeys,
  asKey,
  canonical,
  ensureEntity,
  keyOf,
  NATIVE_STATS_EPOCH,
  stableUuid,
  StatsFailure,
  touch,
} from './stats-common';

export type AuthorityRow = {
  id: string;
  entity_id: string;
  issuer: 'MAXIM' | 'EXCHANGE';
  role: 'SOURCE' | 'CONSUMER';
  producer: 'MAXIM' | 'EXCHANGE';
  consumer: 'MAXIM' | 'EXCHANGE';
  actor_max_id: string;
  bot_ref: string;
  purpose: 'OWNER_ANALYTICS' | 'PUBLISHED_AGGREGATE';
  scopes: StatsMetricKey[];
  revision: bigint;
  epoch: bigint;
  producer_epoch: string;
  local_access_fence: string;
  state: 'ACTIVE' | 'REVOKED';
  peer_valid_until: Date;
  checked_at: Date;
  native_ref: unknown;
};
const active = (r: AuthorityRow) =>
  r.state === 'ACTIVE' && r.peer_valid_until.getTime() > Date.now();
const grants = (r: AuthorityRow, key: StatsMetricKey) =>
  r.scopes.some((s) => keyOf(s) === keyOf(key));

@Injectable()
export class StatsAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}
  checkEpoch(epoch: string) {
    if (
      !this.config.get<string>('STATISTICS_CENTRAL_EXCHANGE_EPOCH') ||
      epoch !== this.config.get<string>('STATISTICS_CENTRAL_EXCHANGE_EPOCH')
    )
      throw new StatsFailure('RETIRED_PRODUCER_EPOCH', 403);
  }
  async attest(request: StatsAuthorityRequest): Promise<StatsAuthorityResult> {
    return this.prisma.$transaction(
      async (tx) => {
        const results: StatsAuthorityResult['results'] = [];
        for (const [index, op] of request.operations.entries()) {
          this.checkEpoch(op.producerEpoch);
          const entity = await ensureEntity(tx, op.entity);
          const rows = await tx.$queryRaw<
            AuthorityRow[]
          >`SELECT * FROM stats_authorities WHERE id=${op.id}::uuid FOR UPDATE`;
          const old = rows[0];
          if (
            old &&
            (old.issuer !== 'EXCHANGE' ||
              old.entity_id !== entity.id ||
              old.role !== op.role ||
              old.consumer !== op.consumer ||
              old.actor_max_id !== op.actorMaxUserId ||
              old.purpose !== op.purpose)
          )
            throw new StatsFailure('FORBIDDEN', 403, request.requestId);
          const reply = (
            status: StatsAuthorityResult['results'][number]['status'],
            r: AuthorityRow,
            errorCode: StatsAuthorityResult['results'][number]['errorCode'] = null,
          ) =>
            results.push({
              index,
              id: r.id,
              epoch: r.epoch.toString(),
              state: !active(r) && r.state === 'ACTIVE' ? 'EXPIRED' : r.state,
              status,
              peerValidUntil: active(r) ? r.peer_valid_until.toISOString() : null,
              errorCode,
            });
          if (old && BigInt(op.revision) < old.revision) {
            reply('SUPERSEDED', old);
            continue;
          }
          const scopeChanged = old && canonical(old.scopes) !== canonical(op.scopes);
          // FLAG: A current issuer proof may change the bot only with a newer
          // revision. The new epoch fences every prior consumer/source reference.
          const botChanged = old && old.bot_ref !== op.botRef;
          if (
            old &&
            BigInt(op.revision) === old.revision &&
            (botChanged ||
              scopeChanged ||
              old.local_access_fence !== op.localAccessFence ||
              old.state !== (op.operation === 'ATTEST' ? 'ACTIVE' : 'REVOKED') ||
              old.producer_epoch !== op.producerEpoch)
          )
            throw new StatsFailure('STALE_LOCAL_FENCE', 403, request.requestId);
          const checked = new Date(op.checkedAt);
          const validUntil = new Date(Math.min(checked.getTime() + 300_000, Date.now() + 300_000));
          if (
            op.operation === 'ATTEST' &&
            (checked.getTime() > Date.now() + 30_000 || validUntil.getTime() <= Date.now())
          ) {
            results.push({
              index,
              id: op.id,
              epoch: old?.epoch.toString() ?? '0',
              state: 'UNAVAILABLE',
              status: 'DENIED',
              peerValidUntil: null,
              errorCode: 'STALE_LOCAL_FENCE',
            });
            continue;
          }
          const changed = !old || BigInt(op.revision) > old.revision;
          const epoch = old ? old.epoch + (changed ? 1n : 0n) : 1n;
          const state = op.operation === 'ATTEST' ? 'ACTIVE' : 'REVOKED';
          await tx.$executeRaw`INSERT INTO stats_authorities(id,entity_id,issuer,role,producer,consumer,actor_max_id,bot_ref,purpose,scopes,revision,epoch,producer_epoch,local_access_fence,state,peer_valid_until,checked_at)
      VALUES(${op.id}::uuid,${entity.id}::uuid,'EXCHANGE',${op.role},'EXCHANGE',${op.consumer},${op.actorMaxUserId},${op.botRef},${op.purpose},${JSON.stringify(op.scopes)}::jsonb,${BigInt(op.revision)},${epoch},${op.producerEpoch}::uuid,${op.localAccessFence},${state},${validUntil},${checked})
      ON CONFLICT(id) DO UPDATE SET bot_ref=EXCLUDED.bot_ref,scopes=EXCLUDED.scopes,revision=EXCLUDED.revision,epoch=EXCLUDED.epoch,producer_epoch=EXCLUDED.producer_epoch,local_access_fence=EXCLUDED.local_access_fence,state=EXCLUDED.state,peer_valid_until=EXCLUDED.peer_valid_until,checked_at=EXCLUDED.checked_at,updated_at=now()`;
          if (changed) await touch(tx, entity.id, 'AUTHORITY', op.id);
          const current = {
            ...old,
            id: op.id,
            epoch,
            state,
            peer_valid_until: validUntil,
          } as AuthorityRow;
          reply(changed ? 'APPLIED' : op.operation === 'ATTEST' ? 'RENEWED' : 'DUPLICATE', current);
          if (op.role === 'CONSUMER' && state === 'ACTIVE')
            await this.nativeSources(
              tx,
              entity.id,
              op.entity,
              op.actorMaxUserId,
              op.purpose,
              op.consumer,
            );
        }
        return { contractVersion: 1, requestId: request.requestId, results };
      },
      { timeout: 10_000 },
    );
  }
  async assertSource(
    tx: Prisma.TransactionClient,
    entityId: string,
    ref: StatsAuthorityRef,
    key: StatsMetricKey,
    ignoreEpoch = false,
  ) {
    const rows = await tx.$queryRaw<
      AuthorityRow[]
    >`SELECT * FROM stats_authorities WHERE id=${ref.id}::uuid FOR SHARE`;
    const r = rows[0];
    if (
      !r ||
      r.entity_id !== entityId ||
      r.issuer !== 'EXCHANGE' ||
      r.producer !== 'EXCHANGE' ||
      r.role !== 'SOURCE' ||
      !active(r) ||
      (!ignoreEpoch && r.epoch.toString() !== ref.epoch) ||
      !grants(r, key) ||
      r.producer_epoch !== this.config.get('STATISTICS_CENTRAL_EXCHANGE_EPOCH')
    )
      throw new StatsFailure('FORBIDDEN', 403);
    return r;
  }
  async currentView(
    tx: Prisma.TransactionClient,
    entityId: string,
    context: StatsReadContext,
    consumer: 'MAXIM' | 'EXCHANGE' = 'EXCHANGE',
  ) {
    const rows = await tx.$queryRaw<
      AuthorityRow[]
    >`SELECT * FROM stats_authorities WHERE id=${context.consumerAuthority.id}::uuid FOR SHARE`;
    const c = rows[0];
    if (
      !c ||
      c.entity_id !== entityId ||
      c.role !== 'CONSUMER' ||
      c.consumer !== consumer ||
      c.actor_max_id !== context.actorMaxUserId ||
      c.purpose !== context.purpose ||
      (c.issuer === 'EXCHANGE' &&
        c.producer_epoch !== this.config.get('STATISTICS_CENTRAL_EXCHANGE_EPOCH')) ||
      !active(c) ||
      c.epoch.toString() !== context.consumerAuthority.epoch
    )
      throw new StatsFailure('FORBIDDEN', 403);
    const sources = await tx.$queryRaw<
      AuthorityRow[]
    >`SELECT * FROM stats_authorities WHERE entity_id=${entityId}::uuid AND actor_max_id=${context.actorMaxUserId} AND purpose=${context.purpose} AND role='SOURCE' AND state='ACTIVE' AND peer_valid_until>now() ORDER BY id LIMIT 64 FOR SHARE`;
    const native = await this.nativeProof(
      tx,
      context.entity,
      context.actorMaxUserId,
      context.purpose,
    );
    const allowed = sources.filter((r) =>
      r.producer === 'EXCHANGE'
        ? r.producer_epoch === this.config.get('STATISTICS_CENTRAL_EXCHANGE_EPOCH')
        : native.some((n) => n.bot_ref === r.bot_ref && n.fence === r.local_access_fence),
    );
    return { consumer: c, sources: allowed };
  }
  dependencies(
    view: { consumer: AuthorityRow; sources: AuthorityRow[] },
    producer: 'MAXIM' | 'EXCHANGE',
    key: StatsMetricKey,
  ): StatsSourceDependency[] {
    if (!grants(view.consumer, key)) return [];
    // One independent current grant suffices. Facts do not inherit their collector's old ACL.
    const r = view.sources.find((s) => s.producer === producer && grants(s, key));
    return r
      ? [
          {
            producer,
            purpose: r.purpose,
            scope: asKey(key),
            sourceAuthorityId: r.id,
            sourceAuthorityEpoch: r.epoch.toString(),
            consumerAuthorityId: view.consumer.id,
            consumerAuthorityEpoch: view.consumer.epoch.toString(),
            peerValidUntil: new Date(
              Math.min(r.peer_valid_until.getTime(), view.consumer.peer_valid_until.getTime()),
            ).toISOString(),
          },
        ]
      : [];
  }
  async nativeProof(
    tx: Prisma.TransactionClient,
    entity: StatsEntity,
    actor: string,
    purpose: 'OWNER_ANALYTICS' | 'PUBLISHED_AGGREGATE',
  ) {
    const rows = await this.nativeProofBatch(tx, [entity], actor, purpose);
    return rows.map(({ bot_ref, fence, public_reach }) => ({ bot_ref, fence, public_reach }));
  }
  async nativeProofBatch(
    tx: Prisma.TransactionClient,
    entities: StatsEntity[],
    actor: string,
    purpose: 'OWNER_ANALYTICS' | 'PUBLISHED_AGGREGATE',
  ) {
    if (entities.length > 100) throw new StatsFailure('INVALID_REQUEST', 400);
    if (!entities.length) return [];
    return tx.$queryRaw<
      Array<{
        kind: StatsEntity['kind'];
        max_id: string;
        bot_ref: string;
        fence: string;
        public_reach: boolean;
      }>
    >`SELECT requested.kind,requested."maxId" AS max_id,proof.* FROM jsonb_to_recordset(${JSON.stringify(entities)}::jsonb) AS requested(kind text,"maxId" text) CROSS JOIN LATERAL (SELECT a.bot_id AS bot_ref,
    concat(a.checked_at::text,'|',a.state::text,'|',a.user_role::text,'|',a.bot_role::text,'|',COALESCE(m.lifecycle_event_at,p.lifecycle_event_at)::text) AS fence,
    EXISTS(SELECT 1 FROM marketplace_bindings b WHERE b.actor_user_id=a.user_id AND b.entity_id=a.chat_id AND b.bot_id=a.bot_id AND b.state='ACTIVE' AND b.profile_snapshot->'listing'->>'status'='PUBLISHED' AND b.public_url IS NOT NULL AND b.public_verified_until>now()) AS public_reach
    FROM managed_entity_access_edges a JOIN chats c ON c.id=a.chat_id
    LEFT JOIN chat_bot_memberships m ON m.chat_id=a.chat_id AND m.bot_id=a.bot_id AND m.status='ACTIVE'
    LEFT JOIN publisher_entity_bindings p ON p.chat_id=a.chat_id AND p.publisher_bot_id=a.bot_id AND p.status='ACTIVE'
    WHERE c.entity_type::text=requested.kind AND a.chat_id=requested."maxId" AND a.user_id=${actor} AND a.entity_type::text=requested.kind AND a.state='GRANTED' AND a.user_role IN ('OWNER','ADMIN') AND a.bot_role IN ('OWNER','ADMIN')
    AND (m.bot_id IS NOT NULL OR p.publisher_bot_id IS NOT NULL)
    AND (m.bot_access_state IS NULL OR m.bot_access_checked_at IS NULL OR m.bot_access_checked_at<a.checked_at OR m.bot_access_state IN ('CONFIRMED_ADMIN','CONFIRMED_OWNER'))
    AND (p.bot_access_state IS NULL OR p.bot_access_checked_at IS NULL OR p.bot_access_checked_at<a.checked_at OR p.bot_access_state IN ('CONFIRMED_ADMIN','CONFIRMED_OWNER'))
    AND NOT EXISTS(SELECT 1 FROM chat_membership_activity_events e WHERE e.chat_id=a.chat_id AND e.user_id=a.user_id AND e.event_type='user_removed' AND e.event_at>=a.checked_at)
    AND (${purpose}='OWNER_ANALYTICS' OR EXISTS(SELECT 1 FROM marketplace_bindings b WHERE b.actor_user_id=a.user_id AND b.entity_id=a.chat_id AND b.bot_id=a.bot_id AND b.state='ACTIVE' AND b.profile_snapshot->'listing'->>'status'='PUBLISHED'))
    ORDER BY a.bot_id LIMIT 32) proof`;
  }
  async nativeSources(
    tx: Prisma.TransactionClient,
    entityId: string,
    entity: StatsEntity,
    actor: string,
    purpose: 'OWNER_ANALYTICS' | 'PUBLISHED_AGGREGATE',
    consumer: 'MAXIM' | 'EXCHANGE',
  ) {
    const proofs = await this.nativeProof(tx, entity, actor, purpose);
    for (const proof of proofs) {
      const scopes = allKeys.filter(
        (k) =>
          k.method.id !== 'MAXFRAME_EXTERNAL_CALENDAR' &&
          (entity.kind === 'CHANNEL' || k.metric === 'AUDIENCE' || k.metric === 'MEMBERSHIP') &&
          (purpose === 'OWNER_ANALYTICS' ||
            k.metric === 'AUDIENCE' ||
            (k.metric !== 'MEMBERSHIP' && proof.public_reach)),
      );
      const id = stableUuid(['MAXIM', 'SOURCE', entityId, actor, proof.bot_ref, purpose, consumer]);
      const old = (
        await tx.$queryRaw<
          AuthorityRow[]
        >`SELECT * FROM stats_authorities WHERE id=${id}::uuid FOR UPDATE`
      )[0];
      const changed =
        !old ||
        old.local_access_fence !== proof.fence ||
        canonical(old.scopes) !== canonical(scopes) ||
        old.state !== 'ACTIVE';
      await tx.$executeRaw`INSERT INTO stats_authorities(id,entity_id,issuer,role,producer,consumer,actor_max_id,bot_ref,purpose,scopes,revision,epoch,producer_epoch,local_access_fence,state,peer_valid_until,checked_at,native_ref)
    VALUES(${id}::uuid,${entityId}::uuid,'MAXIM','SOURCE','MAXIM',${consumer},${actor},${proof.bot_ref},${purpose},${JSON.stringify(scopes)}::jsonb,1,1,${NATIVE_STATS_EPOCH}::uuid,${proof.fence},'ACTIVE',now()+interval '5 minutes',now(),${JSON.stringify({ kind: entity.kind, maxId: entity.maxId, botRef: proof.bot_ref })}::jsonb)
    ON CONFLICT(id) DO UPDATE SET epoch=stats_authorities.epoch+${changed ? 1n : 0n},revision=stats_authorities.revision+${changed ? 1n : 0n},scopes=EXCLUDED.scopes,local_access_fence=EXCLUDED.local_access_fence,state='ACTIVE',peer_valid_until=EXCLUDED.peer_valid_until,checked_at=now(),updated_at=now()`;
      if (changed) await touch(tx, entityId, 'AUTHORITY', id);
    }
  }
  async localContext(
    entity: StatsEntity,
    actor: string,
    bot: string,
    scopes: StatsMetricKey[],
  ): Promise<StatsReadContext> {
    return this.prisma.$transaction(async (tx) => {
      const e = await ensureEntity(tx, entity);
      const purpose = 'OWNER_ANALYTICS';
      const proofs = await this.nativeProof(tx, entity, actor, purpose);
      const proof = proofs.find((p) => p.bot_ref === bot);
      if (!proof) throw new StatsFailure('FORBIDDEN', 403);
      const id = stableUuid(['MAXIM', 'CONSUMER', e.id, actor, bot, purpose]);
      const old = (
        await tx.$queryRaw<
          AuthorityRow[]
        >`SELECT * FROM stats_authorities WHERE id=${id}::uuid FOR UPDATE`
      )[0];
      const changed =
        !old ||
        old.local_access_fence !== proof.fence ||
        canonical(old.scopes) !== canonical(scopes);
      await tx.$executeRaw`INSERT INTO stats_authorities(id,entity_id,issuer,role,producer,consumer,actor_max_id,bot_ref,purpose,scopes,revision,epoch,producer_epoch,local_access_fence,state,peer_valid_until,checked_at)
    VALUES(${id}::uuid,${e.id}::uuid,'MAXIM','CONSUMER','MAXIM','MAXIM',${actor},${bot},${purpose},${JSON.stringify(scopes)}::jsonb,1,1,${NATIVE_STATS_EPOCH}::uuid,${proof.fence},'ACTIVE',now()+interval '5 minutes',now())
    ON CONFLICT(id) DO UPDATE SET epoch=stats_authorities.epoch+${changed ? 1n : 0n},revision=stats_authorities.revision+${changed ? 1n : 0n},scopes=EXCLUDED.scopes,local_access_fence=EXCLUDED.local_access_fence,state='ACTIVE',peer_valid_until=EXCLUDED.peer_valid_until,checked_at=now()`;
      await this.nativeSources(tx, e.id, entity, actor, purpose, 'MAXIM');
      return {
        contextId: id,
        entity,
        actorMaxUserId: actor,
        purpose,
        consumerAuthority: { id, epoch: (old ? old.epoch + (changed ? 1n : 0n) : 1n).toString() },
      };
    });
  }
}
