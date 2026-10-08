import type { MaxUpdate } from '@maxim/contracts';
import { Prisma, type WebhookEvent, type WebhookExecutionClaim } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { buildGroupCommandKey } from '../common/group-command-key';
import { DORMANT_BOT_OBSERVATION_MARKER } from './webhook-dormant-observation';
import { hasWebhookReplayFence } from './webhook-execution-deadline';
import { readLegacyReceiptClaims } from './webhook-legacy-claims';
import { legacyUpdateHeldSql } from './webhook-legacy-hold.service';
import { inspectSourceAbandonmentSource } from './webhook-legacy-source';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import { WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINE_PREFIX } from './webhook-timeout-quarantine';

const prefix = WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINE_PREFIX;
const operatorMarker = new RegExp(`^${prefix}:OPERATOR_DISCARDED:([A-Za-z0-9_-]{8,100})$`, 'u');
const pristineMarker = `${prefix}:PRISTINE_OPERATOR_DISCARD_V1:`;
const FAMILY_LIMIT = 64;
const ROW_BYTE_LIMIT = 256 * 1024;
const FAMILY_BYTE_LIMIT = 1024 * 1024;

function plainSource(event: WebhookEvent): boolean {
  const payload = event.normalizedPayload as unknown as MaxUpdate;
  const raw = payload?.raw as
    | { message?: { link?: unknown; body?: { attachments?: unknown } } }
    | undefined;
  const attachments = raw?.message?.body?.attachments;
  return Boolean(
    raw?.message &&
    raw.message.link === undefined &&
    (attachments === undefined ||
      attachments === null ||
      (Array.isArray(attachments) && attachments.length === 0)),
  );
}

export function pristineDiscardCandidateSql(semanticKey: string) {
  return Prisma.sql`SELECT claim.id, claim.webhook_event_id AS "ownerId"
    FROM (
      SELECT id, webhook_event_id, enforced, status, prepared_at, business_started_at,
        completed_at, command_result, lease_token, lease_expires_at
      FROM webhook_execution_claims WHERE kind = 'EXECUTION' AND semantic_key = ${semanticKey}
      OFFSET 0
    ) claim JOIN webhook_events event ON event.id = claim.webhook_event_id
    WHERE claim.enforced AND claim.status = 'READY' AND claim.prepared_at IS NOT NULL
      AND claim.business_started_at IS NULL AND claim.completed_at IS NULL
      AND claim.command_result IS NULL AND claim.lease_token IS NULL AND claim.lease_expires_at IS NULL
      AND event.execution_deadline_at <= clock_timestamp() AT TIME ZONE 'UTC'
      AND event.processed_at IS NULL
      AND EXISTS (
        SELECT 1 FROM (
          SELECT id FROM webhook_events WHERE semantic_key = ${semanticKey}
          ORDER BY created_at, id LIMIT ${FAMILY_LIMIT + 1}
        ) heads CROSS JOIN LATERAL (
          SELECT error_message, status, raw_payload, normalized_payload
          FROM webhook_events WHERE id = heads.id OFFSET 0
        ) witness
        WHERE witness.status = 'FAILED'
          AND witness.error_message ~ ${operatorMarker.source}
          AND witness.raw_payload = '{}'::jsonb AND witness.normalized_payload = '{}'::jsonb
      )`;
}

function pristine(claim: WebhookExecutionClaim): boolean {
  return (
    claim.kind === 'EXECUTION' &&
    claim.enforced &&
    claim.status === 'READY' &&
    claim.preparedAt instanceof Date &&
    claim.businessStartedAt === null &&
    claim.completedAt === null &&
    claim.commandResult === null &&
    claim.leaseToken === null &&
    claim.leaseExpiresAt === null
  );
}

function noDisposition(event: WebhookEvent): boolean {
  return (
    event.legacyDispositionId === null &&
    event.legacyDispositionReceiptId === null &&
    event.sourceDispositionId === null &&
    event.sourceDispositionReceiptId === null
  );
}

function terminal(event: WebhookEvent): boolean {
  return (
    event.status === 'FAILED' &&
    event.processedAt === null &&
    event.queueName === null &&
    event.queuedAt === null &&
    event.nextEnqueueAt === null &&
    event.timeoutQuarantineExpiresAt === null &&
    noDisposition(event)
  );
}

function empty(value: unknown): boolean {
  return Boolean(
    value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0,
  );
}

// FLAG: This may retire only a never-started modern owner already fenced by exact
// operator-discarded copies. It never proves old effects absent, completes a claim,
// installs a hold, or enters preparation/transport. Started sources keep cold recovery.
export async function settlePristineOperatorDiscard(
  prisma: PrismaService,
  input: { webhookEventId: string; update: MaxUpdate },
): Promise<boolean> {
  if (input.update.type !== 'message_created') return false;
  const semanticKey = buildWebhookSemanticEventKey(input.update);
  if (!semanticKey) return false;
  const query = pristineDiscardCandidateSql(semanticKey);
  const [candidate] = await prisma.$queryRaw<Array<{ id: string; ownerId: string }>>(query);
  if (!candidate) return false;

  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw(Prisma.sql`SET LOCAL lock_timeout = '500ms'`);
      await tx.$executeRaw(Prisma.sql`SET LOCAL statement_timeout = '1000ms'`);
      // FLAG: Match business start/expiry lock order: claim before receipts. A held claim
      // prevents lease/start races; receipt locks also fence FK-linked direct claims.
      await tx.$queryRaw(Prisma.sql`SELECT id FROM webhook_execution_claims
      WHERE id = ${candidate.id} FOR UPDATE`);
      const [rechecked] = await tx.$queryRaw<Array<{ id: string; ownerId: string }>>(query);
      if (rechecked?.id !== candidate.id || rechecked.ownerId !== candidate.ownerId) return false;
      const claim = await tx.webhookExecutionClaim.findUnique({ where: { id: candidate.id } });
      if (
        !claim ||
        !pristine(claim) ||
        claim.webhookEventId !== candidate.ownerId ||
        claim.semanticKey !== semanticKey
      )
        return false;
      const familyIds = await tx.webhookEvent.findMany({
        where: { semanticKey },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: FAMILY_LIMIT + 1,
        select: { id: true },
      });
      if (
        !familyIds.length ||
        familyIds.length > FAMILY_LIMIT ||
        !familyIds.some((row) => row.id === input.webhookEventId)
      )
        return false;
      const ids = familyIds.map((row) => row.id);
      await tx.$queryRaw(Prisma.sql`SELECT id FROM webhook_events
      WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`);
      const currentIds = await tx.webhookEvent.findMany({
        where: { semanticKey },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: FAMILY_LIMIT + 1,
        select: { id: true },
      });
      if (
        currentIds.length !== ids.length ||
        currentIds.some((row, index) => row.id !== ids[index])
      )
        return false;
      const sizes = await tx.$queryRaw<Array<{ id: string; bytes: number }>>(Prisma.sql`
      SELECT id, octet_length(raw_payload::text) + octet_length(normalized_payload::text) AS bytes
      FROM webhook_events WHERE id IN (${Prisma.join(ids)})`);
      if (
        sizes.length !== ids.length ||
        sizes.some((row) => !Number.isSafeInteger(row.bytes) || row.bytes > ROW_BYTE_LIMIT) ||
        sizes.reduce((sum, row) => sum + row.bytes, 0) > FAMILY_BYTE_LIMIT
      )
        return false;
      const family = await tx.webhookEvent.findMany({
        where: { id: { in: ids } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const owner = family.find((row) => row.id === claim.webhookEventId);
      const current = family.find((row) => row.id === input.webhookEventId);
      if (
        !owner ||
        !current ||
        family.some((row) => row.semanticKey !== semanticKey || !noDisposition(row))
      )
        return false;
      const [clock] = await tx.$queryRaw<Array<{ now: Date; cutoff: Date }>>(Prisma.sql`
      SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now, finished_at AS cutoff
      FROM _prisma_migrations WHERE migration_name = '20261005020000_add_multibot_order_fences'
        AND finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC LIMIT 1`);
      if (
        !clock ||
        !owner.executionDeadlineAt ||
        owner.executionDeadlineAt > clock.now ||
        [claim.createdAt, claim.preparedAt!, ...family.map((row) => row.createdAt)].some(
          (at) => !Number.isFinite(at.getTime()) || at <= clock.cutoff || at > clock.now,
        ) ||
        claim.preparedAt! < claim.createdAt ||
        claim.createdAt < owner.createdAt
      )
        return false;
      const settings = await tx.chatSettings.findUnique({
        where: { chatId: input.update.message?.chatId ?? '' },
      });
      const source = inspectSourceAbandonmentSource(owner, undefined, settings ?? undefined);
      if (
        !source ||
        !plainSource(owner) ||
        source.sourceAt <= clock.cutoff ||
        buildWebhookSemanticEventKey(owner.normalizedPayload) !== semanticKey
      )
        return false;
      const claims = await readLegacyReceiptClaims(
        tx,
        owner.id,
        semanticKey,
        buildGroupCommandKey(source.chatId, source.messageId),
      );
      const directClaims = await tx.webhookExecutionClaim.findMany({
        where: { webhookEventId: { in: ids } },
        take: 2,
        select: { id: true },
      });
      if (
        !claims ||
        claims.length !== 1 ||
        claims[0]!.id !== claim.id ||
        directClaims.length !== 1 ||
        directClaims[0]!.id !== claim.id
      )
        return false;
      const held = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT event.id FROM webhook_events event WHERE event.id = ${owner.id}
        AND ${legacyUpdateHeldSql('event')}
      UNION ALL SELECT receipt_id AS id FROM webhook_source_receipt_dispositions
        WHERE receipt_id IN (${Prisma.join(ids)})
      UNION ALL SELECT receipt_id AS id FROM webhook_legacy_receipt_dispositions
        WHERE receipt_id IN (${Prisma.join(ids)}) LIMIT 1`);
      if (held.length) return false;
      const discards = family.filter(
        (row) =>
          terminal(row) &&
          operatorMarker.test(row.errorMessage ?? '') &&
          empty(row.rawPayload) &&
          empty(row.normalizedPayload),
      );
      const witness = discards[0];
      if (
        !witness ||
        witness.createdAt <= owner.createdAt ||
        discards.some((row) => row.id === current.id)
      )
        return false;
      const marker = `${pristineMarker}${operatorMarker.exec(witness.errorMessage!)![1]}`;
      const wasSettled = terminal(owner) && owner.errorMessage === marker;
      if (
        !wasSettled &&
        (current.id !== owner.id ||
          owner.processedAt !== null ||
          !['RECEIVED', 'QUEUED', 'FAILED'].includes(owner.status) ||
          hasWebhookReplayFence(owner))
      )
        return false;
      let observations = 0;
      for (const event of family) {
        if (discards.some((row) => row.id === event.id)) continue;
        const provenance = inspectSourceAbandonmentSource(event, undefined, settings ?? undefined);
        if (
          !provenance ||
          !plainSource(event) ||
          provenance.chatId !== source.chatId ||
          provenance.messageId !== source.messageId ||
          provenance.userId !== source.userId ||
          provenance.sourceAt.getTime() !== source.sourceAt.getTime()
        )
          return false;
        if (event.id === owner.id) continue;
        if (
          event.status === 'PROCESSED' &&
          event.errorMessage === DORMANT_BOT_OBSERVATION_MARKER &&
          event.processedAt !== null &&
          event.queueName === null &&
          event.queuedAt === null &&
          event.nextEnqueueAt === null &&
          event.timeoutQuarantineExpiresAt === null
        ) {
          observations++;
          continue;
        }
        if (wasSettled && terminal(event) && event.errorMessage === marker) continue;
        if (
          wasSettled &&
          event.createdAt > owner.createdAt &&
          event.processedAt === null &&
          ['RECEIVED', 'QUEUED', 'FAILED'].includes(event.status) &&
          !hasWebhookReplayFence(event)
        )
          continue;
        return false;
      }
      if (!observations || family[0]!.errorMessage !== DORMANT_BOT_OBSERVATION_MARKER) return false;
      if (terminal(current) && current.errorMessage === marker) return true;
      // FLAG: Existing terminal readers release ordering and permanently deny replay. The
      // original claim, body, deadline, uncertainty evidence and every other receipt stay intact.
      const changed = await tx.webhookEvent.updateMany({
        where: {
          id: current.id,
          status: current.status,
          errorMessage: current.errorMessage,
          processedAt: null,
          normalizedPayload: { equals: current.normalizedPayload as Prisma.InputJsonValue },
        },
        data: {
          status: 'FAILED',
          errorMessage: marker,
          queueName: null,
          queuedAt: null,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: null,
        },
      });
      return changed.count === 1;
    },
    { maxWait: 1_000, timeout: 3_000 },
  );
}
