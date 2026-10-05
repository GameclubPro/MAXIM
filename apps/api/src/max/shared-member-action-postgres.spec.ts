import { randomUUID } from 'node:crypto';
import { MaxActionLedgerService } from './max-action-ledger.service';
import type { MaxActionJob } from './max-client.service';
import { Prisma } from '../prisma/prisma-client';
import {
  createMultibotHarness,
  type MultibotHarness,
} from '../webhook/webhook-multibot-fullpath.spec-support';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const stores = databaseUrl && redisUrl ? describe : describe.skip;
jest.setTimeout(60_000);

stores('shared production member identity on PostgreSQL/Redis/BullMQ', () => {
  let h: MultibotHarness | undefined;
  afterEach(async () => {
    await h?.dispose();
    h = undefined;
  });
  async function fixture(bots = 4) {
    h = await createMultibotHarness({ databaseUrl, redisUrl, bots, mode: 'on' });
    const [chatId] = await h.seedCatalog(1);
    return { s: h, chatId: chatId! };
  }
  function job(
    chatId: string,
    botId: string,
    actionType: 'BAN_MEMBER' | 'KICK_MEMBER' | 'TRY_UNBAN_MEMBER' = 'BAN_MEMBER',
  ): MaxActionJob {
    return {
      actionType,
      chatId,
      userId: 'fixture-user',
      botId,
      idempotencyKey: `member-${randomUUID()}`,
      attempt: 1,
      createdAt: new Date().toISOString(),
    };
  }

  it.each(
    [1, 4, 9, 3, 6, 12].flatMap((bots) =>
      (['BAN_MEMBER', 'KICK_MEMBER'] as const).map((actionType) => ({ bots, actionType })),
    ),
  )(
    'does not repeat an unknown $actionType with $bots bots through real moderation wrappers',
    async ({ bots, actionType }) => {
      const { s, chatId } = await fixture(bots);
      const moderation = s.moderation as unknown as {
        banMemberImmediatelyWithResult(chatId: string, userId: string): Promise<{ ok: boolean }>;
        kickMemberImmediately(chatId: string, userId: string): Promise<boolean>;
      };
      const execute = async () =>
        actionType === 'BAN_MEMBER'
          ? (await moderation.banMemberImmediatelyWithResult(chatId, 'fixture-user')).ok
          : moderation.kickMemberImmediately(chatId, 'fixture-user');
      s.ambiguousNextMemberMutation();
      await expect(execute()).rejects.toThrow(`Ambiguous MAX ${actionType} transport failure`);
      for (const bot of s.bots.slice(0, bots === 1 ? 1 : -1)) await s.demote(chatId, bot.id);
      if (bots === 1) expect(await execute()).toBe(false);
      else
        await expect(execute()).rejects.toThrow(
          actionType === 'BAN_MEMBER'
            ? 'no longer executable (AMBIGUOUS)'
            : 'Retained member action requires settlement',
        );
      const effects = s.effects.filter(
        (item) => item.method === 'delete' && item.path === `/chats/${chatId}/members`,
      );
      expect(effects).toHaveLength(1);
      const rows = await s.prisma.maxActionLedgerEntry.findMany({ where: { chatId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'AMBIGUOUS', ambiguous: true, attemptCount: 1 });
    },
  );

  it('atomically claims one member operation across independently constructed ledger services', async () => {
    const { s, chatId } = await fixture();
    const first = job(chatId, s.bots[0]!.id, 'BAN_MEMBER');
    const second = job(chatId, s.bots[3]!.id, 'KICK_MEMBER');
    const outcomes = await Promise.allSettled([
      new MaxActionLedgerService(s.prisma as never).recordStarted(first),
      new MaxActionLedgerService(s.prisma as never).recordStarted(second),
    ]);
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === 'rejected')).toHaveLength(1);
    expect(
      await s.prisma.maxActionLedgerEntry.count({ where: { chatId, status: 'IN_PROGRESS' } }),
    ).toBe(1);
  });

  it.each(['IN_PROGRESS', 'AMBIGUOUS', 'SUCCEEDED'] as const)(
    'fences retained legacy bot-scoped BAN with %s under a new identity',
    async (status) => {
      const { s, chatId } = await fixture();
      const prior = job(chatId, s.bots[0]!.id);
      await s.prisma.maxActionLedgerEntry.create({
        data: {
          jobId: prior.idempotencyKey,
          actionType: 'BAN_MEMBER',
          chatId,
          userId: prior.userId,
          botId: prior.botId,
          status,
          ambiguous: status === 'AMBIGUOUS',
          terminal: status !== 'IN_PROGRESS',
          attemptCount: 1,
          firstAttemptAt: new Date(),
          lastAttemptAt: new Date(),
        },
      });
      await expect(
        s.max.banMember(chatId, 'fixture-user', { botId: s.bots[3]!.id, immediate: true }),
      ).rejects.toThrow('Retained member action requires settlement');
      expect(s.effects).toHaveLength(0);
      expect(await s.prisma.maxActionLedgerEntry.count({ where: { chatId } })).toBe(1);
    },
  );

  it('allows a fresh ban only after confirmed unban clears the old terminal BAN evidence', async () => {
    const { s, chatId } = await fixture();
    await s.max.banMember(chatId, 'fixture-user', { botId: s.bots[0]!.id, immediate: true });
    await expect(
      s.max.banMember(chatId, 'fixture-user', { botId: s.bots[3]!.id, immediate: true }),
    ).rejects.toThrow('no longer executable');
    // FLAG: MAX retired API restoration; this fixture models confirmed external unban.
    await s.max.clearTerminalBanStateAfterConfirmedUnban(chatId, 'fixture-user');
    await s.max.banMember(chatId, 'fixture-user', { botId: s.bots[3]!.id, immediate: true });
    expect(s.effects.filter((item) => item.params?.block === true)).toHaveLength(2);
  });

  it('allows one guarded attempt after a confirmed BAN and keeps its evidence', async () => {
    const { s, chatId } = await fixture();
    await s.max.banMember(chatId, 'fixture-user', { botId: s.bots[0]!.id, immediate: true });
    const beforeImmediateMemberMutation = jest.fn().mockResolvedValue(undefined);
    const attemptOptions = {
      botId: s.bots[3]!.id,
      immediate: true,
      idempotencyKey: 'selected-sanction',
      beforeImmediateMemberMutation,
    };
    await s.max.attemptUnbanMember(chatId, 'fixture-user', attemptOptions);
    await expect(
      s.max.attemptUnbanMember(chatId, 'fixture-user', { ...attemptOptions, botId: s.bots[1]!.id }),
    ).rejects.toThrow('no longer executable');
    expect(beforeImmediateMemberMutation).toHaveBeenCalledTimes(1);
    const rows = await s.prisma.maxActionLedgerEntry.findMany({ where: { chatId } });
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actionType: 'BAN_MEMBER', status: 'SUCCEEDED' }),
        expect.objectContaining({
          actionType: 'TRY_UNBAN_MEMBER',
          status: 'SUCCEEDED',
          attemptCount: 1,
        }),
      ]),
    );
    const effects = s.effects.filter((item) => item.path === `/chats/${chatId}/members`);
    expect(effects.map((item) => item.params?.block)).toEqual([true, false]);
    await expect(
      s.max.kickMember(chatId, 'fixture-user', { immediate: true, botId: s.bots[2]!.id }),
    ).rejects.toThrow('Retained member action requires settlement');
  });

  it.each(['IN_PROGRESS', 'AMBIGUOUS'] as const)(
    'does not attempt unban after a BAN with %s effects',
    async (status) => {
      const { s, chatId } = await fixture();
      const prior = job(chatId, s.bots[0]!.id);
      await s.prisma.maxActionLedgerEntry.create({
        data: {
          jobId: prior.idempotencyKey,
          actionType: prior.actionType,
          chatId,
          userId: prior.userId,
          status,
          ambiguous: status === 'AMBIGUOUS',
          terminal: status === 'AMBIGUOUS',
          attemptCount: 1,
        },
      });
      await expect(
        s.max.attemptUnbanMember(chatId, 'fixture-user', {
          immediate: true,
          botId: s.bots[3]!.id,
          idempotencyKey: 'selected-sanction',
          beforeImmediateMemberMutation: async () => {},
        }),
      ).rejects.toThrow('Retained member action requires settlement');
      expect(s.effects).toHaveLength(0);
    },
  );

  it('fences an ambiguous attempt across identities and later member operations', async () => {
    const { s, chatId } = await fixture();
    await s.max.banMember(chatId, 'fixture-user', { immediate: true, botId: s.bots[0]!.id });
    const opts = {
      immediate: true,
      botId: s.bots[3]!.id,
      idempotencyKey: 'selected-sanction',
      beforeImmediateMemberMutation: async () => {},
    };
    s.ambiguousNextMemberMutation();
    await expect(s.max.attemptUnbanMember(chatId, 'fixture-user', opts)).rejects.toThrow(
      'Ambiguous MAX TRY_UNBAN_MEMBER',
    );
    await expect(s.max.attemptUnbanMember(chatId, 'fixture-user', opts)).rejects.toThrow(
      'no longer executable',
    );
    await expect(
      s.max.attemptUnbanMember(chatId, 'fixture-user', {
        ...opts,
        idempotencyKey: 'another-sanction',
      }),
    ).rejects.toThrow('Retained member action requires settlement');
    // Model a later externally confirmed return; an unknown attempt remains crash-fenced.
    await s.max.clearTerminalBanStateAfterConfirmedUnban(chatId, 'fixture-user');
    await expect(
      s.max.banMember(chatId, 'fixture-user', { immediate: true, botId: s.bots[1]!.id }),
    ).rejects.toThrow('Retained member action requires settlement');
    expect(s.effects.filter((item) => item.method === 'delete')).toHaveLength(2);
    expect(
      await s.prisma.maxActionLedgerEntry.findFirst({
        where: { chatId, actionType: 'TRY_UNBAN_MEMBER' },
      }),
    ).toMatchObject({ status: 'AMBIGUOUS', ambiguous: true, attemptCount: 1 });
  });

  it.each([true, false])(
    'bounds member-effect lookup independently of terminal history (block completed BAN: %s)',
    async (blockCompletedBan) => {
      const { s, chatId } = await fixture();
      await s.prisma.$executeRaw(Prisma.sql`
      INSERT INTO max_action_ledger (id, job_id, action_type, chat_id, user_id, status, terminal, updated_at)
      SELECT ${`${chatId}-history-`} || i, ${`${chatId}-history-job-`} || i,
        'KICK_MEMBER', ${chatId}, 'fixture-user', 'SUCCEEDED'::"MaxActionLedgerStatus", TRUE, CURRENT_TIMESTAMP
      FROM generate_series(1, 20000) AS i
    `);
      await s.prisma.$executeRaw(Prisma.sql`
      INSERT INTO max_action_ledger (id, job_id, action_type, chat_id, user_id, status, terminal, updated_at)
      SELECT ${`${chatId}-attempt-history-`} || i, ${`${chatId}-attempt-history-job-`} || i,
        'TRY_UNBAN_MEMBER', ${chatId}, 'fixture-user', 'SUCCEEDED'::"MaxActionLedgerStatus", TRUE, CURRENT_TIMESTAMP
      FROM generate_series(1, 20000) AS i
    `);
      const prior = job(chatId, s.bots[0]!.id);
      await s.ledger.recordStarted(prior);
      await s.prisma.$executeRaw`ANALYZE max_action_ledger`;
      const plans = await s.prisma.$queryRaw<
        Array<{ 'QUERY PLAN': Array<{ Plan: Record<string, unknown> }> }>
      >(Prisma.sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT job_id FROM max_action_ledger
      WHERE chat_id = ${chatId} AND user_id = 'fixture-user' AND job_id <> 'a-new-identity'
        AND action_type IN ('BAN_MEMBER', 'KICK_MEMBER', 'TRY_UNBAN_MEMBER')
        AND (status = 'IN_PROGRESS'::"MaxActionLedgerStatus" OR ambiguous = TRUE
          OR (${blockCompletedBan} AND action_type = 'BAN_MEMBER' AND status = 'SUCCEEDED'::"MaxActionLedgerStatus")) LIMIT 1
    `);
      const serialized = JSON.stringify(plans);
      expect(serialized).toContain('max_action_ledger_member_attempt_fence_idx');
      const walk = (node: Record<string, unknown>): void => {
        if (node['Relation Name'] === 'max_action_ledger') {
          expect(
            Number(node['Actual Rows']) + Number(node['Rows Removed by Filter'] ?? 0),
          ).toBeLessThanOrEqual(2);
        }
        for (const child of (node.Plans ?? []) as Record<string, unknown>[]) walk(child);
      };
      walk(plans[0]!['QUERY PLAN'][0]!.Plan);
    },
  );
});
