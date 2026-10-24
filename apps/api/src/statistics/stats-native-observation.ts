import { createHash } from 'node:crypto';
import type { StatsCoverage, StatsEntity } from '@maxim/contracts/statistics-central';
import { Prisma } from '../prisma/prisma-client';

const NATIVE_EPOCH = '00000000-0000-4000-8000-000000000001';

export function statisticsCentralEnabled(): boolean {
  return (
    ['true', '1'].includes(process.env.STATISTICS_CENTRAL_ENABLED ?? '') &&
    process.env.STATISTICS_CENTRAL_MODE === 'CENTRAL'
  );
}

/** Keep native membership projection, its trigger rollup, and invalidation in one statement. */
export function withStatsMembershipInvalidation(statement: Prisma.Sql): Prisma.Sql {
  if (!statisticsCentralEnabled()) return statement;
  // FLAG: Only actual source changes invalidate analytics; duplicate delivery is a SQL no-op.
  return Prisma.sql`
    WITH native_changed AS (${statement} RETURNING chat_id,event_type,event_at),
    stats_touched AS (
      INSERT INTO stats_entities(kind,max_id,data_revision)
      SELECT c.entity_type::text,c.id,1 FROM chats c
      JOIN native_changed n ON n.chat_id=c.id
      WHERE c.entity_type IN ('CHAT','CHANNEL') AND c.id ~ '^-[1-9][0-9]{0,19}$'
        AND n.event_type IN ('user_added','user_removed')
        AND n.event_at >= (now() AT TIME ZONE 'UTC')::date-89
      GROUP BY c.entity_type,c.id
      ON CONFLICT(kind,max_id) DO UPDATE SET data_revision=stats_entities.data_revision+1
      RETURNING id,data_revision
    ) INSERT INTO stats_changes(entity_id,entity_revision,cause)
      SELECT id,data_revision,'DATA' FROM stats_touched`;
}

/** The native writer's transaction owns both its observation and this invalidation. */
export async function touchStatsEntity(
  tx: Prisma.TransactionClient,
  entity: StatsEntity,
): Promise<{ id: string; data_revision: bigint } | null> {
  if (!statisticsCentralEnabled()) return null;
  const [row] = await tx.$queryRaw<Array<{ id: string; data_revision: bigint }>>`
    INSERT INTO stats_entities(kind,max_id,data_revision) VALUES(${entity.kind},${entity.maxId},1)
    ON CONFLICT(kind,max_id) DO UPDATE SET data_revision=stats_entities.data_revision+1
    RETURNING id,data_revision`;
  await tx.$executeRaw`INSERT INTO stats_changes(entity_id,entity_revision,cause)
    VALUES(${row.id}::uuid,${row.data_revision},'DATA')`;
  return row;
}

/** Only new chat observations need storage: the previous native model is latest-only. */
export async function captureStatsChatAudience(
  tx: Prisma.TransactionClient,
  entity: StatsEntity,
  value: number,
  observedAt: Date,
): Promise<void> {
  if (!statisticsCentralEnabled() || entity.kind !== 'CHAT') return;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 2_147_483_647 ||
    !Number.isFinite(observedAt.getTime()) ||
    observedAt.getTime() < today.getTime() - 89 * 86_400_000 ||
    observedAt.getTime() > Date.now() + 30_000
  )
    return;
  // FLAG: Lock the independent statistics entity, never create a Chat/bot/binding.
  const [entityRow] = await tx.$queryRaw<Array<{ id: string; data_revision: bigint }>>`
    INSERT INTO stats_entities(kind,max_id) VALUES(${entity.kind},${entity.maxId})
    ON CONFLICT(kind,max_id) DO UPDATE SET max_id=EXCLUDED.max_id RETURNING id,data_revision`;
  const captured = { value, observedAt: observedAt.toISOString() };
  const coverage: StatsCoverage = { state: 'COMPLETE', intervals: [], populationComplete: true };
  const hash = createHash('sha256')
    .update(JSON.stringify({ value: captured, coverage }))
    .digest('hex');
  const revision = entityRow.data_revision + 1n;
  const changed = await tx.$executeRaw`
    INSERT INTO stats_measurements(entity_id,producer,metric,horizon,method_id,method_version,day,
      producer_epoch,seen_revision,seen_hash,value_revision,value_hash,deleted,value,coverage,
      observed_from,observed_to)
    VALUES(${entityRow.id}::uuid,'MAXIM','AUDIENCE',0,'AUDIENCE_SNAPSHOT',1,
      ${observedAt.toISOString().slice(0, 10)}::date,${NATIVE_EPOCH}::uuid,${revision},${hash},
      ${revision},${hash},false,${JSON.stringify(captured)}::jsonb,${JSON.stringify(coverage)}::jsonb,
      ${observedAt},${observedAt})
    ON CONFLICT(entity_id,producer,metric,horizon,method_id,method_version,day) DO UPDATE SET
      seen_revision=EXCLUDED.seen_revision,seen_hash=EXCLUDED.seen_hash,
      value_revision=EXCLUDED.value_revision,value_hash=EXCLUDED.value_hash,deleted=false,
      value=EXCLUDED.value,coverage=EXCLUDED.coverage,observed_from=EXCLUDED.observed_from,
      observed_to=EXCLUDED.observed_to,updated_at=now()
    WHERE stats_measurements.producer_epoch=EXCLUDED.producer_epoch
      AND (stats_measurements.observed_to IS NULL OR stats_measurements.observed_to<EXCLUDED.observed_to)`;
  if (changed) await touchStatsEntity(tx, entity);
}
