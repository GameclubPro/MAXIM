import type { ConfigService } from '@nestjs/config';
import type { StatsAudienceValue, StatsEntity } from '@maxim/contracts/statistics-central';
import type { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { StatsAccessService } from './stats-access.service';
import { DAY_MS, hash, StatsFailure, unknownHealth } from './stats-common';
import { selectStats } from './stats-selector';
import type { StatsCandidate } from './stats-types';

const identity = (entity: StatsEntity) => `${entity.kind}:${entity.maxId}`;
type Proof = Awaited<ReturnType<StatsAccessService['nativeProofBatch']>>[number];
type Peer = {
  kind: StatsEntity['kind'];
  max_id: string;
  id: string;
  epoch: bigint;
  local_access_fence: string;
  producer_epoch: string;
};
type Point = {
  kind: StatsEntity['kind'];
  max_id: string;
  producer: 'MAXIM' | 'EXCHANGE';
  value: number | null;
  observed_at: Date | null;
  observed_iso: string | null;
  saturated: boolean;
};

// A local consumer is authorized by the same exact durable SQL bot/actor proof used by
// localContext. Reads do not renew a peer lease or turn a peer fact into a native fact.
async function permissions(
  tx: Prisma.TransactionClient,
  access: StatsAccessService,
  config: ConfigService,
  entities: StatsEntity[],
  actor: string,
) {
  const native = await access.nativeProofBatch(tx, entities, actor, 'OWNER_ANALYTICS');
  const peers = await tx.$queryRaw<Peer[]>`
    SELECT requested.kind,requested."maxId" AS max_id,a.id,a.epoch,a.local_access_fence,a.producer_epoch
    FROM jsonb_to_recordset(${JSON.stringify(entities)}::jsonb) AS requested(kind text,"maxId" text)
    JOIN stats_entities e ON e.kind=requested.kind AND e.max_id=requested."maxId"
    CROSS JOIN LATERAL(SELECT id,epoch,local_access_fence,producer_epoch FROM stats_authorities
      WHERE entity_id=e.id AND actor_max_id=${actor} AND purpose='OWNER_ANALYTICS'
      AND role='SOURCE' AND issuer='EXCHANGE' AND producer='EXCHANGE' AND state='ACTIVE'
      AND producer_epoch=${config.get<string>('STATISTICS_CENTRAL_EXCHANGE_EPOCH') ?? null}::uuid
      AND peer_valid_until>clock_timestamp()
      AND scopes @> '[{"metric":"AUDIENCE","horizon":0,"method":{"id":"AUDIENCE_SNAPSHOT","version":1}}]'::jsonb
      ORDER BY id LIMIT 64) a`;
  const key = (row: Proof | Peer) => `${row.kind}:${row.max_id}`;
  const allowed = new Set(native.map(key));
  const fingerprint = hash({
    native: native.map((p) => [key(p), p.bot_ref, p.fence]).sort(),
    peers: peers
      .filter((p) => allowed.has(key(p)))
      .map((p) => [key(p), p.id, p.epoch.toString(), p.local_access_fence, p.producer_epoch])
      .sort(),
  });
  return { allowed, peers: new Set(peers.map(key)), fingerprint };
}

export async function readLocalAudienceCurrent(
  prisma: PrismaService,
  access: StatsAccessService,
  config: ConfigService,
  input: StatsEntity[],
  actor: string,
  asOf: Date,
  transaction?: Prisma.TransactionClient,
) {
  if (!Number.isFinite(asOf.getTime())) throw new StatsFailure('INVALID_REQUEST', 400);
  const entities = [...new Map(input.map((entity) => [identity(entity), entity])).values()];
  const results: Array<{ entity: StatsEntity; value: number; observedAt: Date }> = [];
  const checks: Array<{ entities: StatsEntity[]; fingerprint: string }> = [];
  // The network has no total favourite cap. Each query handles <=100 exact entities,
  // one audience metric and one current point per raw source; no 90-day per-entity reader loop.
  for (let offset = 0; offset < entities.length; offset += 100) {
    const chunk = entities.slice(offset, offset + 100);
    const load = async (tx: Prisma.TransactionClient) => {
      const before = await permissions(tx, access, config, chunk, actor);
      const allowed = chunk.filter((entity) => before.allowed.has(identity(entity)));
      if (!allowed.length) return { before, rows: [] as Point[] };
      const from = new Date(
        Date.parse(`${asOf.toISOString().slice(0, 10)}T00:00:00Z`) - 89 * DAY_MS,
      );
      const rows = await tx.$queryRaw<Point[]>`
        WITH requested AS MATERIALIZED(SELECT * FROM jsonb_to_recordset(${JSON.stringify(allowed)}::jsonb) AS r(kind text,"maxId" text))
        SELECT r.kind,r."maxId" AS max_id,p.producer,p.value,p.observed_at,
          to_char(p.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_iso,p.saturated FROM requested r
        CROSS JOIN LATERAL(
          SELECT 'MAXIM'::text AS producer,participants_count AS value,observed_at,false AS saturated
          FROM managed_entity_audience_observations WHERE chat_id=r."maxId" AND entity_type::text=r.kind AND observed_at BETWEEN ${from} AND ${asOf}
          UNION ALL
          (SELECT 'MAXIM',participants_count,captured_at AT TIME ZONE 'UTC',false
            FROM channel_audience_snapshots WHERE r.kind='CHANNEL' AND chat_id=r."maxId" AND participants_count IS NOT NULL AND captured_at BETWEEN ${from} AND ${asOf}
            ORDER BY captured_at DESC LIMIT 1)
          UNION ALL
          (WITH bindings AS MATERIALIZED(SELECT id,kind FROM marketplace_bindings WHERE entity_id=r."maxId" LIMIT 65)
            SELECT 'MAXIM',a.audience,a.observed_at,(SELECT count(*) FROM bindings)>64 FROM bindings b
            LEFT JOIN LATERAL(SELECT audience,observed_at FROM marketplace_audience_observations
              WHERE b.kind=r.kind AND binding_id=b.id AND bucket BETWEEN ${from} AND ${asOf} AND observed_at BETWEEN ${from} AND ${asOf}
              ORDER BY bucket DESC LIMIT 1) a ON true)
          UNION ALL
          SELECT m.producer,(m.value->>'value')::integer,(m.value->>'observedAt')::timestamptz,false
            FROM stats_entities e JOIN stats_measurements m ON m.entity_id=e.id
            WHERE e.kind=r.kind AND e.max_id=r."maxId" AND m.metric='AUDIENCE' AND m.horizon=0 AND m.method_id='AUDIENCE_SNAPSHOT'
              AND m.method_version=1 AND m.day BETWEEN ${from}::date AND ${asOf}::date AND NOT m.deleted
              AND m.value->>'value' IS NOT NULL AND m.value->>'observedAt' IS NOT NULL
              AND (m.value->>'observedAt')::timestamptz BETWEEN ${from} AND ${asOf}
        ) p`;
      return { before, rows };
    };
    const { before, rows } = transaction
      ? await load(transaction)
      : await prisma.$transaction(load, { isolationLevel: 'RepeatableRead', timeout: 15_000 });
    checks.push({ entities: chunk, fingerprint: before.fingerprint });
    for (const entity of chunk) {
      const key = identity(entity);
      if (!before.allowed.has(key)) continue;
      const points = rows.filter((row) => `${row.kind}:${row.max_id}` === key);
      if (points.some((row) => row.saturated)) continue;
      const candidates: StatsCandidate[] = points
        .filter(
          (row): row is Point & { value: number; observed_iso: string } =>
            row.value !== null &&
            row.observed_iso !== null &&
            (row.producer === 'MAXIM' || before.peers.has(key)),
        )
        .map((row) => ({
          producer: row.producer,
          scope: {
            metric: 'AUDIENCE',
            horizon: 0,
            method: { id: 'AUDIENCE_SNAPSHOT', version: 1 },
            day: row.observed_iso.slice(0, 10),
          },
          value: { value: row.value, observedAt: row.observed_iso },
          coverage: { state: 'COMPLETE', intervals: [], populationComplete: true },
          health: unknownHealth(),
        }));
      const latest = selectStats(candidates).at(-1);
      if (latest) {
        const value = latest.value as StatsAudienceValue;
        if (value.value !== null && value.observedAt)
          results.push({ entity, value: value.value, observedAt: new Date(value.observedAt) });
      }
    }
  }
  // FLAG: The caller must close its snapshot before this current-access readback.
  // A nested pool acquisition while every caller holds a transaction can deadlock.
  const verifyAccess = async () => {
    for (const check of checks) {
      const after = await prisma.$transaction((tx) =>
        permissions(tx, access, config, check.entities, actor),
      );
      if (check.fingerprint !== after.fingerprint) throw new StatsFailure('READ_RESTART', 409);
    }
  };
  if (!transaction) await verifyAccess();
  return { rows: results, verifyAccess };
}
