import { randomUUID } from 'node:crypto';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookLegacyHoldService } from '../webhook/webhook-legacy-hold.service';
import { fingerprintModerationSettings } from './moderation-settings-fingerprint';
import {
  buildMessageScopedModerationActionClaimKey,
  buildModerationMessageViolationProcessingClaimKey,
} from './moderation-message-action-claim';
import {
  buildRequiredSubscriptionCandidateId,
  RequiredSubscriptionCandidateStore,
  type RequiredSubscriptionCandidateFreezeContext,
} from './required-subscription-candidate.store';
import type {
  FrozenRequiredSubscriptionCandidatePlan,
  RequiredSubscriptionCandidateDeleteReceipt,
  RequiredSubscriptionCandidateSource,
} from './required-subscription-candidate-workflow';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
(databaseUrl ? describe : describe.skip)('native initial subscription candidate ownership', () => {
  let prisma: PrismaService;
  let store: RequiredSubscriptionCandidateStore;
  const chats: string[] = [];
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test') ||
      process.env.DATABASE_URL !== databaseUrl
    )
      throw new Error('Disposable local race_test database required');
    prisma = new PrismaService();
    await prisma.$connect();
    const zone = await prisma.$queryRaw<Array<{ zone: string }>>(
      Prisma.sql`SELECT current_setting('TimeZone') AS zone`,
    );
    expect(zone[0]!.zone).toBe('UTC');
    store = new RequiredSubscriptionCandidateStore(prisma, new WebhookLegacyHoldService(prisma));
  });
  afterAll(async () => {
    if (!prisma) return;
    await prisma.chat.deleteMany({ where: { id: { in: chats } } });
    await prisma.$disconnect();
  });

  async function fixture(
    action: 'NONE' | 'WARN' | 'MUTE' | 'BAN' = 'WARN',
    requiredChannelIds: Prisma.InputJsonValue = ['target'],
  ) {
    const chatId = `subscription-candidate-${randomUUID()}`;
    chats.push(chatId);
    await prisma.chat.create({ data: { id: chatId, title: 'Subscription candidate native test' } });
    const settings = await prisma.chatSettings.create({
      data: {
        chatId,
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: requiredChannelIds,
        requiredSubscriptionWarnEnabled: true,
        requiredSubscriptionMuteEnabled: true,
        requiredSubscriptionBanEnabled: true,
        requiredSubscriptionMuteDurationHours: 1,
      },
    });
    const sourceAtMs = Date.now() - 1_000;
    const source: RequiredSubscriptionCandidateSource = {
      version: 1,
      chatId,
      userId: 'user',
      messageId: 'message',
      sourceAtMs,
      deadlineAtMs: sourceAtMs + 300_000,
      policySha256: fingerprintModerationSettings(settings, 'REQUIRED_SUBSCRIPTION'),
      originBotId: 'origin',
      updateType: 'message_created',
      mediaScope: null,
      userLabel: 'User',
      maskedExcerpt: 'masked',
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
    };
    const registered = await store.register(source);
    const row = await store.claim(registered.id);
    if (!row?.leaseToken) throw new Error('Native candidate lease missing');
    const qualification = { requiredChannelIds: ['target'], missingChannelIds: ['target'] };
    const buildPlan = (
      context: RequiredSubscriptionCandidateFreezeContext,
    ): FrozenRequiredSubscriptionCandidatePlan => ({
      version: 1,
      candidateId: context.candidateId,
      source: context.source,
      qualification: context.qualification,
      violationCount24h: context.violationCount24h,
      sanction: {
        action,
        issuedAtMs: context.issuedAtMs,
        muteExpiresAtMs: action === 'MUTE' ? context.issuedAtMs + 3_600_000 : null,
        muteDurationHours: action === 'MUTE' ? 1 : 0,
        eventId: context.eventId,
        noticeKey: `required-subscription:notice:v1:${context.source.chatId}:${context.source.messageId}`,
      },
      notice: {
        version: 1,
        action,
        renderedText: 'Subscribe',
        messageOptions: {},
        mediaFieldKey: null,
        deleteBotMessagesEnabled: false,
        deleteBotMessagesDelayMinutes: 5,
        executionProof: {
          version: 1,
          chatId: source.chatId,
          userId: source.userId,
          messageId: source.messageId,
          reasonKey: 'REQUIRED_SUBSCRIPTION:message-delete',
          policySha256: source.policySha256,
          sourceAtMs: source.sourceAtMs,
          deadlineAtMs: source.deadlineAtMs,
        },
      },
    });
    const input = { id: row.id, leaseToken: row.leaseToken, qualification, buildPlan };
    return { source, row, input, buildPlan, qualification };
  }

  it('retains first immutable source and deadline across concurrent registration and retry', async () => {
    const s = await fixture();
    const rows = await Promise.all([store.register(s.source), store.register(s.source)]);
    expect(rows.map((result) => result.created)).toEqual([false, false]);
    await expect(store.register({ ...s.source, userLabel: 'Changed' })).rejects.toThrow(
      'immutable source conflict',
    );
    await store.finish(s.row.id, s.row.leaseToken!, 'WAITING_CHECK', null, 0);
    const retried = await store.claim(s.row.id);
    expect(retried?.source).toEqual(s.source);
    expect(retried?.deadlineAt.getTime()).toBe(s.source.deadlineAtMs);
  });

  it('claims once and refuses stale owners after lease replacement', async () => {
    const s = await fixture();
    const source = { ...s.source, messageId: 'concurrent' };
    const registered = await store.register(source);
    const claims = await Promise.all([store.claim(registered.id), store.claim(registered.id)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const first = claims.find((row) => row !== null)!;
    await prisma.$executeRaw(Prisma.sql`UPDATE "required_subscription_candidates"
      SET "lease_expires_at" = (clock_timestamp() AT TIME ZONE 'UTC') - INTERVAL '1 second' WHERE "id" = ${first.id}`);
    const second = await store.claim(first.id);
    expect(second?.leaseToken).not.toBe(first.leaseToken);
    await expect(store.assertLease(first.id, first.leaseToken!)).rejects.toThrow('lease lost');
    await expect(store.finish(first.id, first.leaseToken!, 'DONE')).rejects.toThrow('lease lost');
    await expect(store.journal(first.id, first.leaseToken!).markUnknown()).rejects.toThrow(
      'lease lost',
    );
    expect((await store.read(first.id))?.leaseToken).toBe(second?.leaseToken);
  });

  it('refuses malformed persisted channel settings without creating a claim or violation', async () => {
    const s = await fixture('WARN', 'target');
    await expect(store.freezeOwnClaimAndDecision(s.input)).resolves.toEqual({
      kind: 'authority_revoked',
      reason: 'policy_or_author',
    });
    expect(await prisma.violation.count({ where: { chatId: s.source.chatId } })).toBe(0);
    expect(
      await prisma.moderationViolationMessageClaim.count({ where: { chatId: s.source.chatId } }),
    ).toBe(0);
  });

  it('rolls back claim and violation with an invalid plan, then freezes exactly once', async () => {
    const s = await fixture();
    await expect(
      store.freezeOwnClaimAndDecision({
        ...s.input,
        buildPlan: () => {
          throw new Error('copy unavailable');
        },
      }),
    ).rejects.toThrow('copy unavailable');
    expect(await prisma.violation.count({ where: { chatId: s.source.chatId } })).toBe(0);
    expect(
      await prisma.moderationViolationMessageClaim.count({ where: { chatId: s.source.chatId } }),
    ).toBe(0);
    expect((await store.read(s.row.id))?.frozenPlan).toBeNull();
    const first = await store.freezeOwnClaimAndDecision(s.input);
    expect(first.kind).toBe('owned');
    if (first.kind !== 'owned') throw new Error('Decision not owned');
    expect(first.plan.violationCount24h).toBe(1);
    const again = await store.freezeOwnClaimAndDecision({
      ...s.input,
      buildPlan: () => {
        throw new Error('must not recalculate');
      },
    });
    expect(again).toEqual(first);
    expect(await prisma.violation.count({ where: { chatId: s.source.chatId } })).toBe(1);
    expect((await store.read(s.row.id))?.claimId).toBe(`${s.row.id}:claim`);
  });

  it('never adopts another rule or historical claim for the message', async () => {
    const s = await fixture();
    const ruleCode = 'LINK_BLOCKED';
    const key = buildModerationMessageViolationProcessingClaimKey({
      ...s.source,
      ruleCode,
      updateType: 'message_action',
    });
    await prisma.moderationViolationMessageClaim.create({
      data: {
        id: randomUUID(),
        dedupeKey: key.dedupeKey,
        messageActionKey: buildMessageScopedModerationActionClaimKey(
          s.source.chatId,
          s.source.messageId,
        ),
        chatId: s.source.chatId,
        userId: s.source.userId,
        messageId: s.source.messageId,
        ruleCode,
        updateType: 'message_action',
      },
    });
    expect(await store.freezeOwnClaimAndDecision(s.input)).toEqual({
      kind: 'foreign_claim_blocked',
    });
    expect(await prisma.violation.count({ where: { chatId: s.source.chatId } })).toBe(0);
    expect((await store.read(s.row.id))?.frozenPlan).toBeNull();
  });

  it('serializes the first violation count for concurrent messages of one user', async () => {
    const s = await fixture();
    const registered = await store.register({ ...s.source, messageId: 'second' });
    const second = await store.claim(registered.id);
    if (!second?.leaseToken) throw new Error('Second lease missing');
    const results = await Promise.all([
      store.freezeOwnClaimAndDecision(s.input),
      store.freezeOwnClaimAndDecision({
        ...s.input,
        id: second.id,
        leaseToken: second.leaseToken,
        buildPlan: (context) => ({
          ...s.buildPlan(context),
          source: context.source,
          notice: {
            ...s.buildPlan(context).notice,
            executionProof: {
              ...s.buildPlan(context).notice.executionProof,
              messageId: context.source.messageId,
            },
          },
        }),
      }),
    ]);
    expect(
      results
        .flatMap((result) => (result.kind === 'owned' ? [result.plan.violationCount24h] : []))
        .sort(),
    ).toEqual([1, 2]);
  });

  it('commits mute event, cleanup and checkpoint atomically and recovers the exact event', async () => {
    const s = await fixture('MUTE');
    const frozen = await store.freezeOwnClaimAndDecision(s.input);
    if (frozen.kind !== 'owned') throw new Error('Mute decision missing');
    const event = await store.persistDeterministicEvent({
      id: s.row.id,
      leaseToken: s.row.leaseToken!,
    });
    expect(event.createdAt.getTime()).toBe(frozen.plan.sanction.issuedAtMs);
    expect(event.metadata).toMatchObject({
      requiredSubscriptionCandidateId: s.row.id,
      muteExpiresAt: new Date(frozen.plan.sanction.muteExpiresAtMs!).toISOString(),
    });
    expect(await prisma.automaticMuteCleanup.count({ where: { eventId: event.id } })).toBe(1);
    expect(await store.journal(s.row.id, s.row.leaseToken!).readState()).toMatchObject({
      phase: 'SQL_COMMITTED',
      eventId: event.id,
    });
    await prisma.chatSettings.update({
      where: { chatId: s.source.chatId },
      data: { requiredSubscriptionEnabled: false },
    });
    expect(
      await store.persistDeterministicEvent({ id: s.row.id, leaseToken: s.row.leaseToken! }),
    ).toEqual(event);
    expect(await prisma.moderationEvent.count({ where: { chatId: s.source.chatId } })).toBe(1);
  });

  it('rejects revoked policy before a new event and preserves insert-only effect receipts', async () => {
    const s = await fixture('WARN');
    await store.freezeOwnClaimAndDecision(s.input);
    await prisma.chatSettings.update({
      where: { chatId: s.source.chatId },
      data: { requiredSubscriptionEnabled: false },
    });
    await expect(
      store.persistDeterministicEvent({ id: s.row.id, leaseToken: s.row.leaseToken! }),
    ).rejects.toThrow();
    expect(await prisma.moderationEvent.count({ where: { chatId: s.source.chatId } })).toBe(0);
    const receipt = {
      candidateId: s.row.id,
      chatId: s.source.chatId,
      userId: s.source.userId,
      messageId: s.source.messageId,
      sourceAtMs: s.source.sourceAtMs,
      deadlineAtMs: s.source.deadlineAtMs,
      policySha256: s.source.policySha256,
      kind: 'notice_handoff' as const,
      noticeKey: `required-subscription:notice:v1:${s.source.chatId}:${s.source.messageId}`,
      receiptId: 'first',
    };
    await store.recordReceipt(s.row.id, s.row.leaseToken!, 'notice', receipt);
    await store.recordReceipt(s.row.id, s.row.leaseToken!, 'notice', receipt);
    await expect(
      store.recordReceipt(s.row.id, s.row.leaseToken!, 'notice', {
        ...receipt,
        receiptId: 'second',
      }),
    ).rejects.toThrow('receipt conflict');
    await expect(
      store.recordReceipt(s.row.id, s.row.leaseToken!, 'notice', { ...receipt, userId: 'other' }),
    ).rejects.toThrow('binding mismatch');
    expect((await store.readEffects(s.row.id, s.row.leaseToken!)).notice).toEqual(receipt);
  });

  it('preserves the first exact DELETE transfer across allowed downstream status snapshots', async () => {
    const s = await fixture();
    const receipt: RequiredSubscriptionCandidateDeleteReceipt = {
      candidateId: s.row.id,
      chatId: s.source.chatId,
      userId: s.source.userId,
      messageId: s.source.messageId,
      sourceAtMs: s.source.sourceAtMs,
      deadlineAtMs: s.source.deadlineAtMs,
      policySha256: s.source.policySha256,
      intentId: 'exact-delete-intent',
      reasonKey: 'REQUIRED_SUBSCRIPTION:message-delete',
      rollout: 'execute',
      status: 'PENDING',
    };
    await store.recordReceipt(s.row.id, s.row.leaseToken!, 'delete', receipt);
    const statuses: RequiredSubscriptionCandidateDeleteReceipt['status'][] = [
      'IN_PROGRESS',
      'RETRYABLE',
      'WAITING_CAPABILITY',
      'SUCCEEDED',
      'ALREADY_ABSENT',
    ];
    await Promise.all(
      statuses.map((status) =>
        store.recordReceipt(s.row.id, s.row.leaseToken!, 'delete', { ...receipt, status }),
      ),
    );
    expect((await store.readEffects(s.row.id, s.row.leaseToken!)).delete).toEqual(receipt);
    await expect(
      store.recordReceipt(s.row.id, s.row.leaseToken!, 'delete', {
        ...receipt,
        intentId: 'foreign-intent',
        status: 'SUCCEEDED',
      }),
    ).rejects.toThrow('receipt conflict');
    await expect(
      store.recordReceipt(s.row.id, s.row.leaseToken!, 'delete', {
        ...receipt,
        userId: 'foreign-user',
        status: 'SUCCEEDED',
      }),
    ).rejects.toThrow('binding mismatch');
    await prisma.$executeRaw(Prisma.sql`
      UPDATE "required_subscription_candidates"
      SET "effects" = jsonb_set("effects", '{delete,status}', '"AMBIGUOUS"'::jsonb)
      WHERE "id" = ${s.row.id}
    `);
    await expect(
      store.recordReceipt(s.row.id, s.row.leaseToken!, 'delete', receipt),
    ).rejects.toThrow('receipt conflict');
  });

  it('keeps expired candidates visible but gives an unstarted source no new decision', async () => {
    const s = await fixture();
    const sourceAtMs = Date.now() - 301_000;
    const registered = await store.register({
      ...s.source,
      messageId: 'expired',
      sourceAtMs,
      deadlineAtMs: sourceAtMs + 300_000,
    });
    const row = await store.claim(registered.id);
    if (!row?.leaseToken) throw new Error('Expired candidate lease missing');
    expect(
      await store.freezeOwnClaimAndDecision({ ...s.input, id: row.id, leaseToken: row.leaseToken }),
    ).toEqual({ kind: 'authority_revoked', reason: 'deadline' });
    expect(await prisma.violation.count({ where: { chatId: s.source.chatId } })).toBe(0);
    await store.finish(row.id, row.leaseToken, 'EXPIRED');
    expect((await store.read(row.id))?.deadlineAt.getTime()).toBe(sourceAtMs + 300_000);
  });

  it('retains an exact media follower coverage receipt with its anchor notice key', async () => {
    const s = await fixture();
    const receipt = {
      candidateId: s.row.id,
      chatId: s.source.chatId,
      userId: s.source.userId,
      messageId: s.source.messageId,
      sourceAtMs: s.source.sourceAtMs,
      deadlineAtMs: s.source.deadlineAtMs,
      policySha256: s.source.policySha256,
      kind: 'media_coverage' as const,
      noticeKey: `required-subscription:notice:v1:${s.source.chatId}:anchor-message`,
      receiptId: 'exact-coverage-receipt',
    };
    await store.recordReceipt(s.row.id, s.row.leaseToken!, 'notice', receipt);
    expect((await store.readEffects(s.row.id, s.row.leaseToken!)).notice).toEqual(receipt);
    await expect(
      store.recordReceipt(s.row.id, s.row.leaseToken!, 'notice', {
        ...receipt,
        messageId: 'uncovered-message',
      }),
    ).rejects.toThrow('binding mismatch');
  });

  it('settles only its confirmed BAN after source expiry without granting a fresh BAN', async () => {
    const s = await fixture('BAN');
    const sourceAtMs = Date.now() - 298_000;
    const registered = await store.register({
      ...s.source,
      messageId: 'near-deadline',
      sourceAtMs,
      deadlineAtMs: sourceAtMs + 300_000,
    });
    const row = await store.claim(registered.id);
    if (!row?.leaseToken) throw new Error('BAN candidate lease missing');
    const frozen = await store.freezeOwnClaimAndDecision({
      ...s.input,
      id: row.id,
      leaseToken: row.leaseToken,
      buildPlan: (context) => ({
        ...s.buildPlan(context),
        notice: {
          ...s.buildPlan(context).notice,
          executionProof: {
            ...s.buildPlan(context).notice.executionProof,
            messageId: context.source.messageId,
            sourceAtMs: context.source.sourceAtMs,
            deadlineAtMs: context.source.deadlineAtMs,
          },
        },
      }),
    });
    if (frozen.kind !== 'owned') throw new Error('BAN decision missing');
    const journal = store.journal(row.id, row.leaseToken);
    expect(await journal.beginBan(`${row.id}:sanction-ban`)).toBe(true);
    await journal.confirmBan('confirmed-executor');
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.max(0, row.deadlineAt.getTime() - Date.now() + 20)),
    );
    expect(
      await store.journal(row.id, row.leaseToken, true).beginBan(`${row.id}:sanction-ban`),
    ).toBe(false);
    await prisma.chatSettings.update({
      where: { chatId: s.source.chatId },
      data: { requiredSubscriptionEnabled: false },
    });
    const event = await store.persistDeterministicEvent({ id: row.id, leaseToken: row.leaseToken });
    expect(event.action).toBe('BAN');
    expect(event.botId).toBe('confirmed-executor');
    expect(event.createdAt.getTime()).toBe(frozen.plan.sanction.issuedAtMs);
    expect(await journal.readState()).toMatchObject({ phase: 'SQL_COMMITTED', eventId: event.id });
  });

  it('bounds indexed due work with retained history and rotates recovery statuses', async () => {
    const s = await fixture();
    const rows = Array.from({ length: 12_000 }, (_, index) => {
      const source = { ...s.source, messageId: `history-${index}` };
      return {
        id: buildRequiredSubscriptionCandidateId(source),
        chatId: source.chatId,
        messageId: source.messageId,
        source,
        status: index < 6_000 ? 'DONE' : 'WAITING_CHECK',
      };
    });
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "required_subscription_candidates"
        ("id", "chat_id", "user_id", "message_id", "source_at", "deadline_at", "policy_sha256", "source", "status", "next_attempt_at", "updated_at")
      SELECT row.id, row."chatId", ${s.source.userId}, row."messageId", ${new Date(s.source.sourceAtMs)}, ${new Date(s.source.deadlineAtMs)},
        ${s.source.policySha256}, row.source, row.status, (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '1 day',
        (clock_timestamp() AT TIME ZONE 'UTC')
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS row(id text, "chatId" text, "messageId" text, source jsonb, status text)
    `);
    for (let index = 0; index < 5; index += 1)
      await store.register({ ...s.source, messageId: `due-${index}` });
    await store.finish(s.row.id, s.row.leaseToken!, 'UNKNOWN', null, 0);
    const pages = [await store.listDueIds(), await store.listDueIds(), await store.listDueIds()];
    expect(pages.every((page) => page.length <= 4)).toBe(true);
    expect(pages.flat()).toContain(s.row.id);
    await prisma.$executeRaw(Prisma.sql`ANALYZE "required_subscription_candidates"`);
    const plans = await prisma.$queryRaw<
      Array<{ 'QUERY PLAN': Array<{ Plan: Record<string, unknown> }> }>
    >(Prisma.sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT "id" FROM "required_subscription_candidates"
      WHERE "status" = 'WAITING_CHECK' AND "next_attempt_at" <= ${new Date()}
      ORDER BY "next_attempt_at", "id" LIMIT 4
    `);
    const plan = JSON.stringify(plans[0]!['QUERY PLAN'][0]!.Plan);
    expect(plan).toMatch(/required_subscription_candidates_due_idx/);
    expect(plan).not.toMatch(/Seq Scan/);
  });
});
