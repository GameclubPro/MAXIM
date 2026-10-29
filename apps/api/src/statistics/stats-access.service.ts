import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  StatsAuthorityRequest,
  StatsAuthorityResult,
  StatsEntity,
  StatsMetricKey,
  StatsReadContext,
  StatsSourceDependency,
  StatsAuthorityRef,
  StatsAuthorityOperation,
  StatsAuthorityResolveRequest,
  StatsAuthorityResolveResult,
} from '@maxim/contracts/statistics-central';
import {
  statsAuthorityRequestSchema,
  statsAuthorityResolveRequestSchema,
} from '@maxim/contracts/statistics-central-validation';
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
  superseded_by: string | null;
  superseded_at: Date | null;
};
const active = (r: AuthorityRow) =>
  !r.superseded_by && r.state === 'ACTIVE' && r.peer_valid_until.getTime() > Date.now();
const grants = (r: AuthorityRow, key: StatsMetricKey) =>
  r.scopes.some((s) => keyOf(s) === keyOf(key));

function authorityDenial(error: unknown): StatsAuthorityResult['results'][number]['errorCode'] {
  if (!(error instanceof StatsFailure)) return null;
  const response = error.getResponse() as { error?: { code?: unknown } };
  const code = response.error?.code;
  return code === 'FORBIDDEN' || code === 'STALE_LOCAL_FENCE' || code === 'RETIRED_PRODUCER_EPOCH'
    ? code
    : null;
}

function authoritySqlCode(error: unknown, depth = 0): string | null {
  if (!error || typeof error !== 'object' || depth > 4) return null;
  const value = error as Record<string, unknown>;
  for (const key of ['code', 'originalCode', 'sqlState'])
    if (
      typeof value[key] === 'string' &&
      /^[0-9A-Z]{5}$/.test(value[key]) &&
      !/^P\d{4}$/.test(value[key])
    )
      return value[key];
  for (const key of ['meta', 'cause', 'driverAdapterError']) {
    const code = authoritySqlCode(value[key], depth + 1);
    if (code) return code;
  }
  if (value.code === 'P2034') return '40001';
  return null;
}

@Injectable()
export class StatsAccessService {
  private readonly logger = new Logger(StatsAccessService.name);
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
    const parsed = statsAuthorityRequestSchema.safeParse(request);
    if (!parsed.success) throw new StatsFailure('INVALID_REQUEST', 400, request.requestId);
    const groups = new Map<string, Array<{ index: number; op: StatsAuthorityOperation }>>();
    for (const [index, op] of parsed.data.operations.entries()) {
      const key = `${op.entity.kind}/${op.entity.maxId}`;
      const group = groups.get(key) ?? [];
      group.push({ index, op });
      groups.set(key, group);
    }
    const results: StatsAuthorityResult['results'] = [];
    const deadline = Date.now() + 4_000;
    // FLAG: Entity locks precede every authority lock. A failed platform cannot
    // roll back another platform's committed renewal or retain its locks.
    for (const [, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      let completed = false;
      for (let attempt = 0; attempt < 2 && !completed; attempt++) {
        try {
          if (Date.now() >= deadline) throw new Error('Statistics authority deadline exceeded');
          const accepted = await this.prisma.$transaction(
            async (tx) => {
              const entity = await ensureEntity(tx, group[0]!.op.entity);
              const pending: StatsAuthorityResult['results'] = [];
              for (const { op, index } of group)
                pending.push(await this.attestOne(tx, entity.id, op, index, request.requestId));
              return pending;
            },
            {
              maxWait: Math.max(1, Math.min(1_000, deadline - Date.now())),
              timeout: Math.max(1, deadline - Date.now()),
            },
          );
          results.push(...accepted);
          completed = true;
        } catch (error) {
          const code = authoritySqlCode(error);
          if (
            attempt === 0 &&
            ['40P01', '40001'].includes(code ?? '') &&
            Date.now() < deadline - 100
          )
            continue;
          const reason = authorityDenial(error);
          if (!reason)
            this.logger.warn({
              event: 'statistics.authority_entity_unavailable',
              code: code ?? 'UNAVAILABLE',
            });
          results.push(
            ...group.map(({ op, index }) => ({
              index,
              id: op.id,
              epoch: '0',
              state: 'UNAVAILABLE' as const,
              status: 'DENIED' as const,
              peerValidUntil: null,
              errorCode: reason,
            })),
          );
          completed = true;
        }
      }
    }
    results.sort((a, b) => a.index - b.index);
    return { contractVersion: 1, requestId: request.requestId, results };
  }

  async resolve(request: StatsAuthorityResolveRequest): Promise<StatsAuthorityResolveResult> {
    const parsed = statsAuthorityResolveRequestSchema.safeParse(request);
    if (!parsed.success) throw new StatsFailure('INVALID_REQUEST', 400);
    const scope = parsed.data;
    this.checkEpoch(scope.producerEpoch);
    const rows = await this.prisma.$queryRaw<AuthorityRow[]>`
      SELECT a.* FROM stats_entities e JOIN stats_authorities a ON a.entity_id=e.id
      WHERE e.kind=${scope.entity.kind} AND e.max_id=${scope.entity.maxId}
        AND a.issuer='EXCHANGE' AND a.producer='EXCHANGE' AND a.producer_epoch=${scope.producerEpoch}::uuid
        AND a.role=${scope.role} AND a.consumer=${scope.consumer} AND a.actor_max_id=${scope.actorMaxUserId}
        AND a.bot_ref=${scope.botRef} AND a.purpose=${scope.purpose} AND a.superseded_by IS NULL LIMIT 1`;
    const head = rows[0];
    return {
      contractVersion: 1,
      head: head
        ? {
            id: head.id,
            revision: head.revision.toString(),
            epoch: head.epoch.toString(),
            state: head.state === 'ACTIVE' && !active(head) ? 'EXPIRED' : head.state,
          }
        : null,
    };
  }

  private async attestOne(
    tx: Prisma.TransactionClient,
    entityId: string,
    op: StatsAuthorityOperation,
    index: number,
    requestId: string,
  ): Promise<StatsAuthorityResult['results'][number]> {
    this.checkEpoch(op.producerEpoch);
    const old = (
      await tx.$queryRaw<AuthorityRow[]>`
      SELECT * FROM stats_authorities WHERE id=${op.id}::uuid FOR UPDATE`
    )[0];
    if (
      old &&
      (old.issuer !== 'EXCHANGE' ||
        old.producer !== 'EXCHANGE' ||
        old.entity_id !== entityId ||
        old.role !== op.role ||
        old.consumer !== op.consumer ||
        old.actor_max_id !== op.actorMaxUserId ||
        old.purpose !== op.purpose)
    )
      throw new StatsFailure('FORBIDDEN', 403, requestId);
    const reply = (
      status: StatsAuthorityResult['results'][number]['status'],
      row: AuthorityRow,
    ): StatsAuthorityResult['results'][number] => ({
      index,
      id: row.id,
      epoch: row.epoch.toString(),
      state: row.state === 'ACTIVE' && !active(row) ? 'EXPIRED' : row.state,
      status,
      peerValidUntil: active(row) ? row.peer_valid_until.toISOString() : null,
      errorCode: null,
    });
    // FLAG: Supersession is terminal, including a delayed larger revision.
    if (old?.superseded_by) return reply('SUPERSEDED', old);
    if (old && BigInt(op.revision) < old.revision) return reply('SUPERSEDED', old);
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
      throw new StatsFailure('STALE_LOCAL_FENCE', 403, requestId);
    const checked = new Date(op.checkedAt);
    const validUntil = new Date(Math.min(checked.getTime() + 300_000, Date.now() + 300_000));
    if (
      op.operation === 'ATTEST' &&
      (checked.getTime() > Date.now() + 30_000 || validUntil.getTime() <= Date.now())
    )
      throw new StatsFailure('STALE_LOCAL_FENCE', 403, requestId);
    const head = (
      await tx.$queryRaw<AuthorityRow[]>`
      SELECT * FROM stats_authorities WHERE entity_id=${entityId}::uuid AND issuer='EXCHANGE'
        AND producer='EXCHANGE' AND role=${op.role} AND consumer=${op.consumer} AND actor_max_id=${op.actorMaxUserId}
        AND bot_ref=${op.botRef} AND purpose=${op.purpose} AND superseded_by IS NULL FOR UPDATE`
    )[0];
    if (head && head.id !== op.id) {
      if (
        head.state !== 'REVOKED' ||
        head.producer_epoch !== op.producerEpoch ||
        op.supersedes?.id !== head.id ||
        op.supersedes.revision !== head.revision.toString() ||
        op.supersedes.epoch !== head.epoch.toString()
      )
        throw new StatsFailure('STALE_LOCAL_FENCE', 403, requestId);
      // The deferred FK permits retiring the head before inserting its successor.
      await tx.$executeRaw`UPDATE stats_authorities SET superseded_by=${op.id}::uuid,superseded_at=now(),updated_at=now()
        WHERE id=${head.id}::uuid`;
      await touch(tx, entityId, 'AUTHORITY', head.id);
    } else if (op.supersedes) {
      const predecessor = (
        await tx.$queryRaw<AuthorityRow[]>`
        SELECT * FROM stats_authorities WHERE id=${op.supersedes.id}::uuid FOR SHARE`
      )[0];
      if (
        !old ||
        !predecessor ||
        predecessor.superseded_by !== old.id ||
        predecessor.revision.toString() !== op.supersedes.revision ||
        predecessor.epoch.toString() !== op.supersedes.epoch
      )
        throw new StatsFailure('STALE_LOCAL_FENCE', 403, requestId);
    }
    const changed = !old || BigInt(op.revision) > old.revision;
    const epoch = old ? old.epoch + (changed ? 1n : 0n) : 1n;
    const state = op.operation === 'ATTEST' ? 'ACTIVE' : 'REVOKED';
    await tx.$executeRaw`INSERT INTO stats_authorities(id,entity_id,issuer,role,producer,consumer,actor_max_id,bot_ref,purpose,scopes,revision,epoch,producer_epoch,local_access_fence,state,peer_valid_until,checked_at)
      VALUES(${op.id}::uuid,${entityId}::uuid,'EXCHANGE',${op.role},'EXCHANGE',${op.consumer},${op.actorMaxUserId},${op.botRef},${op.purpose},${JSON.stringify(op.scopes)}::jsonb,${BigInt(op.revision)},${epoch},${op.producerEpoch}::uuid,${op.localAccessFence},${state},${validUntil},${checked})
      ON CONFLICT(id) DO UPDATE SET bot_ref=EXCLUDED.bot_ref,scopes=EXCLUDED.scopes,revision=EXCLUDED.revision,epoch=EXCLUDED.epoch,producer_epoch=EXCLUDED.producer_epoch,local_access_fence=EXCLUDED.local_access_fence,state=EXCLUDED.state,peer_valid_until=EXCLUDED.peer_valid_until,checked_at=EXCLUDED.checked_at,updated_at=now()`;
    if (changed) await touch(tx, entityId, 'AUTHORITY', op.id);
    const current = {
      ...old,
      id: op.id,
      epoch,
      state,
      peer_valid_until: validUntil,
    } as AuthorityRow;
    if (op.role === 'CONSUMER' && state === 'ACTIVE')
      await this.nativeSources(tx, entityId, op.entity, op.actorMaxUserId, op.purpose, op.consumer);
    return reply(
      changed ? 'APPLIED' : op.operation === 'ATTEST' ? 'RENEWED' : 'DUPLICATE',
      current,
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
    >`SELECT * FROM stats_authorities WHERE entity_id=${entityId}::uuid AND actor_max_id=${context.actorMaxUserId} AND purpose=${context.purpose} AND role='SOURCE' AND superseded_by IS NULL AND state='ACTIVE' AND peer_valid_until>now() ORDER BY id LIMIT 64 FOR SHARE`;
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
    // FLAG: Successful rechecks refresh checked_at without changing access. Bind the
    // source to the durable edge identity and actual roles/lifecycle; the predicates
    // below still reject current denial/removal before and after every read.
    return tx.$queryRaw<
      Array<{
        kind: StatsEntity['kind'];
        max_id: string;
        bot_ref: string;
        fence: string;
        public_reach: boolean;
      }>
    >`SELECT requested.kind,requested."maxId" AS max_id,proof.* FROM jsonb_to_recordset(${JSON.stringify(entities)}::jsonb) AS requested(kind text,"maxId" text) CROSS JOIN LATERAL (SELECT a.bot_id AS bot_ref,
    concat('native-v2|',a.created_at::text,'|',a.state::text,'|',a.user_role::text,'|',a.bot_role::text,'|',COALESCE(m.lifecycle_event_at,p.lifecycle_event_at)::text) AS fence,
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
