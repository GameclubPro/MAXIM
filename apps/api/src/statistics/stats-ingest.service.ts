import { Injectable } from '@nestjs/common';
import type {
  StatsIngestRequest,
  StatsIngestResult,
  StatsDayKey,
  StatsMembershipValue,
  StatsCoverage,
  StatsHealth,
} from '@maxim/contracts/statistics-central';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { StatsAccessService } from './stats-access.service';
import { DAY_MS, ensureEntity, hash, keyOf, StatsFailure, touch } from './stats-common';
import type { StatsValue } from './stats-types';

type FactRow = {
  producer_epoch: string;
  seen_revision: bigint;
  seen_hash: string;
  value_revision: bigint;
  value_hash: string;
  deleted: boolean;
  value: StatsValue | null;
  coverage: StatsCoverage | null;
  delete_fence: bigint;
};
@Injectable()
export class StatsIngestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: StatsAccessService,
  ) {}
  async ingest(request: StatsIngestRequest): Promise<StatsIngestResult> {
    this.access.checkEpoch(request.producerEpoch);
    const requestHash = hash(request);
    return this.prisma.$transaction(
      async (tx) => {
        const entity = await ensureEntity(tx, request.entity);
        const receipt = (
          await tx.$queryRaw<
            Array<{ body_hash: string; result: StatsIngestResult }>
          >`SELECT body_hash,result FROM stats_ingest_requests WHERE producer='EXCHANGE' AND producer_epoch=${request.producerEpoch}::uuid AND record_kind='REQUEST' AND operation_key=${request.requestId}`
        )[0];
        if (receipt && receipt.body_hash !== requestHash)
          throw new StatsFailure('IDEMPOTENCY_CONFLICT', 409, request.requestId);
        for (const op of request.operations)
          await this.access.assertSource(tx, entity.id, op.authority, op, !!receipt);
        if (receipt) return receipt.result;
        const results: StatsIngestResult['results'] = [];
        let revision = entity.data_revision;
        for (const [index, op] of request.operations.entries()) {
          if (op.operation === 'REPORT_HEALTH') {
            const current = (
              await tx.$queryRaw<
                Array<{
                  health: Record<string, { revision: string; hash: string; health: StatsHealth }>;
                }>
              >`SELECT health FROM stats_entities WHERE id=${entity.id}::uuid`
            )[0]!.health;
            const key = keyOf(op);
            const old = current[key];
            const digest = hash({
              scope: key,
              health: op.health,
              sourceRevision: op.sourceRevision,
            });
            const attempt = op.health.lastAttemptAt,
              success = op.health.lastSuccessAt;
            if (
              (attempt && Date.parse(attempt) > Date.now() + 30_000) ||
              (success && Date.parse(success) > Date.now() + 30_000) ||
              (success && attempt && Date.parse(success) > Date.parse(attempt))
            )
              throw new StatsFailure('INVALID_REQUEST', 400, request.requestId);
            const sourceRevision = BigInt(op.sourceRevision);
            if (old && sourceRevision < BigInt(old.revision)) {
              results.push({
                index,
                status: 'SUPERSEDED',
                seenRevision: old.revision,
                valueRevision: null,
                acceptedEvents: null,
              });
              continue;
            }
            if (old && sourceRevision === BigInt(old.revision)) {
              if (old.hash !== digest)
                throw new StatsFailure('REVISION_CONFLICT', 409, request.requestId);
              results.push({
                index,
                status: 'DUPLICATE',
                seenRevision: old.revision,
                valueRevision: null,
                acceptedEvents: null,
              });
              continue;
            }
            current[key] = { revision: op.sourceRevision, hash: digest, health: op.health };
            await tx.$executeRaw`UPDATE stats_entities SET health=${JSON.stringify(current)}::jsonb WHERE id=${entity.id}::uuid`;
            revision = await touch(tx, entity.id, 'DATA');
            results.push({
              index,
              status: 'APPLIED',
              seenRevision: op.sourceRevision,
              valueRevision: null,
              acceptedEvents: null,
            });
            continue;
          }
          if (op.operation === 'ADD_EVENTS') {
            let accepted = 0;
            let duplicate = 0;
            let high = 0n;
            for (const event of op.events) {
              if (
                Date.parse(event.eventAt) > Date.now() ||
                Date.parse(event.observedAt) > Date.now() + 30_000 ||
                Date.parse(event.eventAt) < Date.now() - 30 * DAY_MS
              )
                throw new StatsFailure('INVALID_REQUEST', 400, request.requestId);
              const scope = {
                metric: 'MEMBERSHIP',
                horizon: 0,
                method: { id: 'OBSERVED_MEMBER_EVENTS', version: 1 },
                day: event.eventAt.slice(0, 10),
              } as StatsDayKey;
              const digest = hash({ entity: request.entity, ...event });
              const prior = (
                await tx.$queryRaw<
                  Array<{ body_hash: string }>
                >`SELECT body_hash FROM stats_ingest_requests WHERE producer='EXCHANGE' AND producer_epoch=${request.producerEpoch}::uuid AND record_kind='EVENT' AND operation_key=${event.eventId}`
              )[0];
              if (prior) {
                if (prior.body_hash !== digest)
                  throw new StatsFailure('EVENT_CONFLICT', 409, request.requestId);
                duplicate++;
                continue;
              }
              const old = await this.fact(tx, entity.id, scope);
              const capture = BigInt(event.capturedRevision);
              high = high > capture ? high : capture;
              const superseded = !!old && capture <= old.delete_fence;
              if (!superseded) {
                const v = (
                  !old?.deleted && old?.value
                    ? old.value
                    : { joined: 0, left: 0, observedFrom: null, observedTo: null }
                ) as StatsMembershipValue;
                const n = event.eventType === 'JOIN' ? 'joined' : 'left';
                v[n] = (v[n] ?? 0) + 1;
                if (v[n]! > 2_147_483_647)
                  throw new StatsFailure('INVALID_REQUEST', 400, request.requestId);
                v.observedFrom =
                  v.observedFrom && v.observedFrom < event.observedAt
                    ? v.observedFrom
                    : event.observedAt;
                v.observedTo =
                  v.observedTo && v.observedTo > event.observedAt ? v.observedTo : event.observedAt;
                const rev = old && old.seen_revision > capture ? old.seen_revision : capture;
                await this.write(tx, entity.id, scope, request.producerEpoch, {
                  seenRevision: rev,
                  seenHash: hash({ membership: true, revision: rev.toString() }),
                  valueRevision: rev,
                  valueHash: hash(v),
                  deleted: false,
                  value: v,
                  coverage: { state: 'PARTIAL', intervals: [], populationComplete: false },
                  deleteFence: old?.delete_fence ?? 0n,
                  authority: op.authority.id,
                });
                accepted++;
              }
              await tx.$executeRaw`INSERT INTO stats_ingest_requests(producer,producer_epoch,record_kind,operation_key,body_hash,result) VALUES('EXCHANGE',${request.producerEpoch}::uuid,'EVENT',${event.eventId},${digest},${JSON.stringify({ entity: request.entity, day: scope.day, capturedRevision: event.capturedRevision, status: superseded ? 'SUPERSEDED' : 'APPLIED' })}::jsonb)`;
            }
            if (accepted) revision = await touch(tx, entity.id, 'DATA');
            results.push({
              index,
              status: accepted
                ? 'APPLIED'
                : duplicate === op.events.length
                  ? 'DUPLICATE'
                  : 'SUPERSEDED',
              seenRevision: high.toString(),
              valueRevision: accepted ? high.toString() : null,
              acceptedEvents: accepted,
            });
            continue;
          }
          this.checkDay(op.day);
          if (op.operation === 'REPLACE_DAY') {
            if (op.metric === 'AUDIENCE' && op.method.id === 'AUDIENCE_SNAPSHOT') {
              const v = op.value as { value: number | null; observedAt: string | null };
              if (
                (v.value === null) !== (v.observedAt === null) ||
                (v.observedAt &&
                  (v.observedAt.slice(0, 10) !== op.day ||
                    Date.parse(v.observedAt) > Date.now() + 30_000))
              )
                throw new StatsFailure('INVALID_REQUEST', 400, request.requestId);
            }
            for (const interval of op.coverage.intervals)
              if (
                interval.from.slice(0, 10) !== op.day ||
                Date.parse(interval.to) > Date.parse(`${op.day}T00:00:00Z`) + DAY_MS
              )
                throw new StatsFailure('INVALID_REQUEST', 400, request.requestId);
          }
          const old = await this.fact(tx, entity.id, op);
          if (old && old.producer_epoch !== request.producerEpoch)
            throw new StatsFailure('RETIRED_PRODUCER_EPOCH', 403, request.requestId);
          const sourceRevision = BigInt(op.sourceRevision);
          const fact: Partial<typeof op> = { ...op };
          delete fact.authority;
          const digest = hash(fact);
          if (old && sourceRevision < old.seen_revision) {
            results.push({
              index,
              status: 'SUPERSEDED',
              seenRevision: old.seen_revision.toString(),
              valueRevision: old.value_revision.toString(),
              acceptedEvents: null,
            });
            continue;
          }
          if (old && sourceRevision === old.seen_revision) {
            if (old.seen_hash !== digest)
              throw new StatsFailure('REVISION_CONFLICT', 409, request.requestId);
            results.push({
              index,
              status: 'DUPLICATE',
              seenRevision: old.seen_revision.toString(),
              valueRevision: old.value_revision.toString(),
              acceptedEvents: null,
            });
            continue;
          }
          if (
            op.operation === 'REPLACE_DAY' &&
            old &&
            !old.deleted &&
            old.coverage?.state === 'COMPLETE' &&
            op.coverage.state !== 'COMPLETE'
          ) {
            await tx.$executeRaw`UPDATE stats_measurements SET seen_revision=${sourceRevision},seen_hash=${digest},updated_at=now() WHERE entity_id=${entity.id}::uuid AND producer='EXCHANGE' AND metric=${op.metric} AND horizon=${op.horizon} AND method_id=${op.method.id} AND method_version=${op.method.version} AND day=${op.day}::date`;
            results.push({
              index,
              status: 'SKIPPED_INCOMPLETE',
              seenRevision: op.sourceRevision,
              valueRevision: old.value_revision.toString(),
              acceptedEvents: null,
            });
            continue;
          }
          const deleted = op.operation === 'DELETE_DAY';
          await this.write(tx, entity.id, op, request.producerEpoch, {
            seenRevision: sourceRevision,
            seenHash: digest,
            valueRevision: sourceRevision,
            valueHash: digest,
            deleted,
            value: deleted ? null : op.value,
            coverage: deleted ? null : op.coverage,
            deleteFence: deleted ? sourceRevision : (old?.delete_fence ?? 0n),
            authority: op.authority.id,
          });
          revision = await touch(tx, entity.id, deleted ? 'DELETE' : 'DATA');
          results.push({
            index,
            status: 'APPLIED',
            seenRevision: op.sourceRevision,
            valueRevision: op.sourceRevision,
            acceptedEvents: null,
          });
        }
        // FLAG: Source SHARE locks remain held through commit, so revocation cannot race an accepted write.
        // Finite leases also have to remain current after applying the bounded request.
        for (const op of request.operations)
          await this.access.assertSource(tx, entity.id, op.authority, op);
        const result: StatsIngestResult = {
          contractVersion: 1,
          requestId: request.requestId,
          entityRevision: revision.toString(),
          results,
        };
        await tx.$executeRaw`INSERT INTO stats_ingest_requests(producer,producer_epoch,record_kind,operation_key,body_hash,result) VALUES('EXCHANGE',${request.producerEpoch}::uuid,'REQUEST',${request.requestId},${requestHash},${JSON.stringify(result)}::jsonb)`;
        return result;
      },
      { timeout: 10_000 },
    );
  }
  private checkDay(day: string) {
    const today = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.parse(`${today}T00:00:00Z`) - 89 * DAY_MS)
      .toISOString()
      .slice(0, 10);
    if (day < from || day > today) throw new StatsFailure('INVALID_REQUEST', 400);
  }
  private async fact(
    tx: Prisma.TransactionClient,
    entityId: string,
    s: StatsDayKey,
  ): Promise<FactRow | undefined> {
    return (
      await tx.$queryRaw<
        FactRow[]
      >`SELECT * FROM stats_measurements WHERE entity_id=${entityId}::uuid AND producer='EXCHANGE' AND metric=${s.metric} AND horizon=${s.horizon} AND method_id=${s.method.id} AND method_version=${s.method.version} AND day=${s.day}::date FOR UPDATE`
    )[0];
  }
  private async write(
    tx: Prisma.TransactionClient,
    entityId: string,
    s: StatsDayKey,
    epoch: string,
    f: {
      seenRevision: bigint;
      seenHash: string;
      valueRevision: bigint;
      valueHash: string;
      deleted: boolean;
      value: StatsValue | null;
      coverage: StatsCoverage | null;
      deleteFence: bigint;
      authority: string;
    },
  ) {
    const v = f.value;
    const from =
      v && 'observedFrom' in v ? v.observedFrom : v && 'observedAt' in v ? v.observedAt : null;
    const to = v && 'observedTo' in v ? v.observedTo : from;
    await tx.$executeRaw`INSERT INTO stats_measurements(entity_id,producer,metric,horizon,method_id,method_version,day,producer_epoch,seen_revision,seen_hash,value_revision,value_hash,deleted,value,coverage,observed_from,observed_to,delete_fence,collected_authority_id)
   VALUES(${entityId}::uuid,'EXCHANGE',${s.metric},${s.horizon},${s.method.id},${s.method.version},${s.day}::date,${epoch}::uuid,${f.seenRevision},${f.seenHash},${f.valueRevision},${f.valueHash},${f.deleted},${v === null ? null : JSON.stringify(v)}::jsonb,${f.coverage === null ? null : JSON.stringify(f.coverage)}::jsonb,${from}::timestamptz,${to}::timestamptz,${f.deleteFence},${f.authority}::uuid)
   ON CONFLICT(entity_id,producer,metric,horizon,method_id,method_version,day) DO UPDATE SET producer_epoch=EXCLUDED.producer_epoch,seen_revision=EXCLUDED.seen_revision,seen_hash=EXCLUDED.seen_hash,value_revision=EXCLUDED.value_revision,value_hash=EXCLUDED.value_hash,deleted=EXCLUDED.deleted,value=EXCLUDED.value,coverage=EXCLUDED.coverage,observed_from=EXCLUDED.observed_from,observed_to=EXCLUDED.observed_to,delete_fence=EXCLUDED.delete_fence,collected_authority_id=EXCLUDED.collected_authority_id,updated_at=now()`;
  }
}
