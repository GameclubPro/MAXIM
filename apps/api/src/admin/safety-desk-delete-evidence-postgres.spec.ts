import { randomUUID } from 'node:crypto';
import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import {
  SafetyDeskDeleteEvidenceService,
  type DeleteReasonOriginRow,
} from './safety-desk-delete-evidence.service';
import {
  buildDeleteEvidenceFollowupsQuery,
  buildDeleteEvidenceReasonsQuery,
  buildDeleteEvidenceOriginsQuery,
} from './safety-desk-delete-evidence.query';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;
jest.setTimeout(60_000);

function planNodes(
  value: unknown,
  found: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) planNodes(item, found);
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  const node = value as Record<string, unknown>;
  if (typeof node['Node Type'] === 'string') found.push(node);
  for (const child of Object.values(node)) planNodes(child, found);
  return found;
}

describePostgres('native delete operation evidence', () => {
  let prisma: PrismaClient;
  const suffix = randomUUID();
  const intentId = `evidence-intent-${suffix}`;
  const chatId = `evidence-chat-${suffix}`;
  const followupId = `evidence-followup-${suffix}-00000`;
  const noticeKey = `${followupId}:sanction-notice`;
  const sourceAt = new Date(Date.now() - 10_000);
  const issuedAtMs = sourceAt.getTime() + 1000;
  const deadlineAt = new Date(sourceAt.getTime() + 300_000);

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Native evidence tests require a local race_test database');
    prisma = createPrismaClient(databaseUrl, { max: 3, statement_timeout: 15_000 });
    await prisma.$connect();
    await prisma.$executeRaw`INSERT INTO chats (id, title, entity_type, catalog_kind, routing_state, routing_version, updated_at)
      VALUES (${chatId}, 'Evidence test', 'CHAT', 'MANAGED', 'READY', 0, CURRENT_TIMESTAMP)`;
    await prisma.$executeRaw`INSERT INTO moderation_delete_intents
      (id, chat_id, message_id, subject_user_id, status, source_message_at, retry_until_at,
       remote_delete_succeeded_at, remote_delete_succeeded_bot_id, succeeded_bot_id, completed_at, created_at, updated_at)
      VALUES (${intentId}, ${chatId}, 'message', 'user', 'SUCCEEDED', ${sourceAt}, ${deadlineAt},
        ${new Date(issuedAtMs)}, 'bot', 'bot', CURRENT_TIMESTAMP, ${sourceAt}, CURRENT_TIMESTAMP)`;
    await prisma.$executeRaw`INSERT INTO moderation_delete_intent_reasons
      (id, intent_id, reason_key, rule_code, user_id, updated_at)
      SELECT ${`evidence-reason-${suffix}-`} || lpad(n::text, 5, '0'), ${intentId},
        'reason-' || lpad(n::text, 5, '0'), 'MESSAGE_TOO_LONG_DELETE', 'user', CURRENT_TIMESTAMP
      FROM generate_series(0, 4999) n`;
    await prisma.$executeRaw`INSERT INTO moderation_rule_followups
      (id, intent_id, reason_key, chat_id, message_id, user_id, rule_code, source_at,
       deadline_at, policy_sha256, envelope, updated_at)
      SELECT ${`evidence-followup-${suffix}-`} || lpad(n::text, 5, '0'), ${intentId},
        'reason-' || lpad(n::text, 5, '0'), ${chatId}, 'message', 'user', 'MESSAGE_TOO_LONG_DELETE',
        ${sourceAt}, ${deadlineAt}, ${'a'.repeat(64)}, '{"version":1,"originBotId":"bot"}'::jsonb, CURRENT_TIMESTAMP
      FROM generate_series(0, 4999) n`;
    await prisma.$executeRaw`UPDATE moderation_rule_followups SET status = 'COMPLETED',
      action_plan = ${JSON.stringify({
        version: 1,
        action: 'WARN',
        issuedAtMs,
        violationCount: 1,
        eventId: `${followupId}:decision`,
        noticeKey,
        muteDurationHours: 0,
        muteExpiresAtMs: null,
      })}::jsonb,
      effects = ${JSON.stringify({ phase: 'SETTLED', eventId: `${followupId}:decision` })}::jsonb
      WHERE id = ${followupId}`;
    await prisma.$executeRaw`INSERT INTO moderation_events
      (id, chat_id, user_id, message_id, event_type, rule_code, action, operator, created_at, metadata)
      VALUES (${`${followupId}:decision`}, ${chatId}, 'user', 'message', 'MESSAGE', 'MESSAGE_TOO_LONG', 'WARN', 'BOT',
        ${new Date(issuedAtMs)}, ${JSON.stringify({ moderationRuleFollowupId: followupId })}::jsonb)`;
    await prisma.$executeRaw`INSERT INTO max_action_ledger
      (id, job_id, action_type, chat_id, bot_id, status, terminal, remote_message_id, completed_at, updated_at, metadata)
      VALUES (${`ledger-${suffix}`}, ${noticeKey}, 'SEND_MESSAGE', ${chatId}, 'bot', 'SUCCEEDED', true,
        'remote-message', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
        ${JSON.stringify({
          ledgerContext: {
            moderationRuleFollowup: { version: 1, id: followupId, issuedAtMs },
            moderationRuleNotice: {
              version: 1,
              chatId,
              messageId: 'message',
              userId: 'user',
              reasonKey: 'reason-00000',
              ruleCode: 'MESSAGE_TOO_LONG_DELETE',
              policySha256: 'a'.repeat(64),
              deadlineAtMs: deadlineAt.getTime(),
            },
          },
          privateMessageText: 'must never leave SQL',
        })}::jsonb)`;
    await prisma.$executeRawUnsafe('ANALYZE moderation_delete_intent_reasons');
    await prisma.$executeRawUnsafe('ANALYZE moderation_rule_followups');
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.maxActionLedgerEntry.deleteMany({ where: { jobId: noticeKey } });
    await prisma.chat.deleteMany({ where: { id: chatId } });
    await prisma.$disconnect();
  });

  it('reads bounded history and projects only exact persisted receipt evidence', async () => {
    expect(
      await prisma.$queryRaw(buildDeleteEvidenceOriginsQuery([`evidence-reason-${suffix}-00000`])),
    ).toEqual([]);
    const service = new SafetyDeskDeleteEvidenceService(prisma as never);
    const snapshot = await service.getEvidence(intentId);
    expect(snapshot.webhookLink).toBe('not_recorded');
    expect(snapshot.deletion.outcome).toBe('confirmed');
    expect(snapshot.reasons.sampleComplete).toBe(false);
    expect(snapshot.reasons.items).toHaveLength(32);
    expect(snapshot.followups.sampleComplete).toBe(false);
    expect(snapshot.followups.items).toHaveLength(32);
    expect(snapshot.followups.items[0]).toMatchObject({
      id: followupId,
      decisionRecorded: true,
      sanctionNotice: { state: 'confirmed', remoteMessageId: 'remote-message' },
      explanation: { state: 'not_recorded' },
    });
    expect(JSON.stringify(snapshot)).not.toContain('must never leave SQL');
    const saved = await prisma.moderationDeleteIntent.findUniqueOrThrow({
      where: { id: intentId },
    });
    expect(saved.status).toBe('SUCCEEDED');
    expect(saved.attemptCount).toBe(0);
  });

  it('uses exact unique intent/reason scans for retained history', async () => {
    for (const [query, relation, index] of [
      [
        buildDeleteEvidenceReasonsQuery(intentId),
        'moderation_delete_intent_reasons',
        'moderation_delete_intent_reasons_intent_reason_key',
      ],
      [
        buildDeleteEvidenceFollowupsQuery(intentId),
        'moderation_rule_followups',
        'moderation_rule_followups_intent_reason_key',
      ],
    ] as const) {
      const plan = await prisma.$queryRaw<unknown[]>(
        Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`,
      );
      const scans = planNodes(plan).filter((node) => node['Relation Name'] === relation);
      expect(scans).toHaveLength(1);
      expect(scans[0]!['Index Name']).toBe(index);
      expect(
        Number(scans[0]!['Actual Rows']) * Number(scans[0]!['Actual Loops']),
      ).toBeLessThanOrEqual(33);
      expect(Number(scans[0]!['Rows Removed by Filter'] ?? 0)).toBe(0);
    }
  });

  it('links bounded first-insert origins through exact receipt and execution claim, retaining gaps after source removal', async () => {
    const receiptId = `origin-receipt-${suffix}`,
      semanticKey = `origin-semantic-${suffix}`;
    const claimId = `origin-claim-${suffix}`;
    await prisma.webhookEvent.create({
      data: {
        id: receiptId,
        dedupKey: receiptId,
        semanticKey,
        botId: 'receiving-bot',
        status: 'PROCESSED',
        createdAt: sourceAt,
        rawPayload: { text: 'private source body' },
        normalizedPayload: {
          type: 'message_edited',
          botId: 'receiving-bot',
          eventTimestampSource: 'payload',
          message: {
            chatId,
            messageId: 'message',
            createdAt: '2020-01-01T00:00:00.000Z',
            text: 'private source body',
          },
          raw: { timestamp: sourceAt.toISOString(), message: { text: 'private source body' } },
        },
      },
    });
    await prisma.webhookExecutionClaim.create({
      data: {
        id: claimId,
        semanticKey,
        webhookEventId: receiptId,
        executionBotId: 'execution-bot',
        enforced: true,
        status: 'COMPLETED',
        businessStartedAt: new Date(sourceAt.getTime() + 500),
      },
    });
    try {
      await prisma.$executeRaw`INSERT INTO moderation_delete_reason_origins
        (reason_id, source_webhook_event_id, source_receiving_bot_id, source_execution_bot_id, source_event_at, source_evidence_version)
        SELECT id, ${receiptId}, 'receiving-bot', 'execution-bot', ${sourceAt}, 1
        FROM moderation_delete_intent_reasons WHERE intent_id = ${intentId}`;
      await prisma.$executeRawUnsafe('ANALYZE moderation_delete_reason_origins');
      const [origin] = await prisma.$queryRaw<DeleteReasonOriginRow[]>(
        buildDeleteEvidenceOriginsQuery([`evidence-reason-${suffix}-00000`]),
      );
      expect(origin?.sourcePayload).toMatchObject({
        raw: { timestamp: sourceAt.toISOString() },
        message: { chatId, messageId: 'message' },
      });
      expect(JSON.stringify(origin)).not.toContain('private source body');
      const service = new SafetyDeskDeleteEvidenceService(prisma as never);
      const snapshot = await service.getEvidence(intentId);
      expect(snapshot.originCoverage).toBe('partial');
      expect(snapshot.reasons.items.every((reason) => reason.origin?.state === 'linked')).toBe(
        true,
      );
      expect(snapshot.reasons.items[0]!.origin).toMatchObject({
        webhookEventId: receiptId,
        receivingBotId: 'receiving-bot',
        executionBotId: 'execution-bot',
        eventAt: sourceAt.toISOString(),
        acceptedAt: sourceAt.toISOString(),
        evidenceVersion: 1,
      });
      expect(JSON.stringify(snapshot)).not.toContain('private source body');
      const reasonIds = Array.from(
        { length: 32 },
        (_, n) => `evidence-reason-${suffix}-${String(n).padStart(5, '0')}`,
      );
      const plan = await prisma.$queryRaw<
        unknown[]
      >(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        ${buildDeleteEvidenceOriginsQuery(reasonIds)}`);
      const scans = planNodes(plan).filter(
        (node) => node['Relation Name'] === 'moderation_delete_reason_origins',
      );
      expect(scans.length).toBeGreaterThan(0);
      expect(scans.every((node) => node['Node Type'] !== 'Seq Scan')).toBe(true);
      expect(
        scans.reduce(
          (sum, node) => sum + Number(node['Actual Rows']) * Number(node['Actual Loops']),
          0,
        ),
      ).toBeLessThanOrEqual(32);
      await prisma.webhookExecutionClaim.update({
        where: { id: claimId },
        data: { executionBotId: 'receiving-bot' },
      });
      expect((await service.getEvidence(intentId)).reasons.items[0]!.origin?.state).toBe(
        'invalid_evidence',
      );
      await prisma.webhookExecutionClaim.update({
        where: { id: claimId },
        data: { executionBotId: 'execution-bot' },
      });
      await prisma.webhookEvent.delete({ where: { id: receiptId } });
      const retained = await service.getEvidence(intentId);
      expect(retained.reasons.items[0]!.origin).toMatchObject({
        state: 'source_unavailable',
        webhookEventId: receiptId,
        acceptedAt: null,
      });
      expect(retained.deletion.outcome).toBe('confirmed');
    } finally {
      await prisma.$executeRaw`DELETE FROM moderation_delete_reason_origins WHERE source_webhook_event_id = ${receiptId}`;
      await prisma.webhookExecutionClaim.deleteMany({ where: { id: claimId } });
      await prisma.webhookEvent.deleteMany({ where: { id: receiptId } });
    }
  });

  it('keeps acknowledged bot cleanup distinct from finalized deletion without changing its fence', async () => {
    await prisma.$executeRaw`UPDATE moderation_delete_intents SET status = 'AMBIGUOUS',
      completed_at = NULL, succeeded_bot_id = NULL,
      last_error_code = 'bot_message_auto_delete_success_verification_pending',
      absence_verified_at = NULL, absence_verified_bot_id = NULL, absence_verification_code = NULL
      WHERE id = ${intentId}`;
    try {
      const snapshot = await new SafetyDeskDeleteEvidenceService(prisma as never).getEvidence(
        intentId,
      );
      expect(snapshot.deletion).toMatchObject({
        status: 'AMBIGUOUS',
        outcome: 'acknowledged',
        completedAt: null,
        acknowledgedAt: new Date(issuedAtMs).toISOString(),
      });
      const retained = await prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { id: intentId },
      });
      expect(retained.status).toBe('AMBIGUOUS');
      expect(retained.completedAt).toBeNull();
      expect(retained.attemptCount).toBe(0);
      expect(retained.lastErrorCode).toBe('bot_message_auto_delete_success_verification_pending');
    } finally {
      await prisma.$executeRaw`UPDATE moderation_delete_intents SET status = 'SUCCEEDED',
        completed_at = CURRENT_TIMESTAMP, succeeded_bot_id = 'bot', last_error_code = NULL
        WHERE id = ${intentId}`;
    }
  });

  it.each(['event-time', 'event-parent', 'malformed-plan-clock'])(
    'rejects mismatched %s in a recorded sanction without unsafe timestamp casts',
    async (failure) => {
      if (failure === 'event-time') {
        await prisma.$executeRaw`UPDATE moderation_events SET created_at = ${new Date(issuedAtMs + 1)}
          WHERE id = ${`${followupId}:decision`}`;
      } else if (failure === 'event-parent') {
        await prisma.$executeRaw`UPDATE moderation_events SET metadata = '{"moderationRuleFollowupId":"other"}'::jsonb
          WHERE id = ${`${followupId}:decision`}`;
      } else {
        await prisma.$executeRaw`UPDATE moderation_rule_followups
          SET action_plan = jsonb_set(action_plan, '{issuedAtMs}', '"invalid-clock"'::jsonb)
          WHERE id = ${followupId}`;
      }
      try {
        const snapshot = await new SafetyDeskDeleteEvidenceService(prisma as never).getEvidence(
          intentId,
        );
        expect(snapshot.followups.items[0]).toMatchObject({
          decisionRecorded: false,
          sanctionNotice: { state: 'invalid_evidence' },
        });
      } finally {
        await prisma.$executeRaw`UPDATE moderation_events SET created_at = ${new Date(issuedAtMs)},
          metadata = ${JSON.stringify({ moderationRuleFollowupId: followupId })}::jsonb
          WHERE id = ${`${followupId}:decision`}`;
        await prisma.$executeRaw`UPDATE moderation_rule_followups
          SET action_plan = jsonb_set(action_plan, '{issuedAtMs}', to_jsonb(${issuedAtMs}::bigint))
          WHERE id = ${followupId}`;
      }
    },
  );

  it('does not adopt a notice from another source version and omits oversized proofs', async () => {
    await prisma.$executeRaw`UPDATE max_action_ledger SET metadata =
      jsonb_set(metadata, '{ledgerContext,moderationRuleFollowup,issuedAtMs}', to_jsonb(${issuedAtMs + 1}::bigint))
      WHERE job_id = ${noticeKey}`;
    const service = new SafetyDeskDeleteEvidenceService(prisma as never);
    expect((await service.getEvidence(intentId)).followups.items[0]?.sanctionNotice.state).toBe(
      'invalid_evidence',
    );
    await prisma.$executeRaw`UPDATE max_action_ledger SET metadata = jsonb_set(metadata,
      '{ledgerContext,moderationRuleFollowup,id}', to_jsonb(repeat('oversized', 10000))) WHERE job_id = ${noticeKey}`;
    const snapshot = await service.getEvidence(intentId);
    expect(snapshot.followups.items[0]?.sanctionNotice.state).toBe('invalid_evidence');
    expect(JSON.stringify(snapshot)).not.toContain('oversized');
  });
});
