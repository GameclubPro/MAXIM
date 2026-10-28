import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPrismaClient, type PrismaClient } from '../prisma/prisma-client';
import type { PublisherBindingRefreshJob } from './publisher-binding-refresh.queue';
import {
  PublisherBindingRefreshService,
  PublisherCandidateRefreshSupersededError,
} from './publisher-binding-refresh.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const integration = databaseUrl ? describe : describe.skip;

integration('Publisher terminal candidate lock order on PostgreSQL', () => {
  let pool: Pool;
  let db: PrismaClient;
  const applicationName = `candidate-terminal-${randomUUID()}`;
  const chatId = `candidate-terminal-${randomUUID()}`;
  const userId = `candidate-actor-${randomUUID()}`;
  const botId = `candidate-bot-${randomUUID()}`;
  const bindingId = randomUUID();
  const activityId = randomUUID();

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    ) {
      throw new Error('Disposable local race_test PostgreSQL database required');
    }
    pool = new Pool({ connectionString: databaseUrl, max: 3, statement_timeout: 10_000 });
    const actual = await pool.query<{ server_version: string; timezone: string }>(
      "SELECT version() AS server_version, current_setting('TimeZone') AS timezone",
    );
    expect(actual.rows[0]?.server_version).toMatch(/^PostgreSQL /u);
    expect(actual.rows[0]?.server_version).not.toMatch(/pglite|wasm/iu);
    expect(actual.rows[0]?.timezone).toBe('UTC');
    db = createPrismaClient(databaseUrl, {
      max: 2,
      application_name: applicationName,
      statement_timeout: 10_000,
    });
    await db.$connect();
  });

  afterAll(async () => {
    await pool?.query('DELETE FROM chat_membership_activity_events WHERE id = $1', [activityId]);
    await db?.marketplaceBinding.deleteMany({ where: { id: bindingId } });
    await db?.chat.deleteMany({ where: { id: chatId } });
    await db?.$disconnect();
    await pool?.end();
  });

  async function waitForBlockedTerminal(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await pool.query<{ blocked: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE application_name = $1 AND cardinality(pg_blocking_pids(pid)) > 0
        ) AS blocked`,
        [applicationName],
      );
      if (result.rows[0]?.blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Terminal candidate writer did not reach the concurrent membership lock');
  }

  it('waits for Chat before touching an edge retained by a membership transition', async () => {
    const eventAt = new Date();
    const candidateVersion = `forwarded:${randomUUID()}`;
    await db.chat.create({ data: { id: chatId, title: 'Terminal lock-order fixture' } });
    await db.managedEntityAccessEdge.create({
      data: {
        chatId,
        userId,
        botId,
        state: 'BOT_DENIED',
        checkedAt: new Date(eventAt.getTime() - 1_000),
        source: 'publisher_actor_candidate_forwarded',
        sourceVersion: candidateVersion,
      },
    });
    await db.marketplaceBinding.create({
      data: {
        id: bindingId,
        actorUserId: userId,
        entityId: chatId,
        kind: 'CHAT',
        profile: 'publisher',
        botId,
        state: 'ACTIVE',
        checkedAt: new Date(eventAt.getTime() - 1_000),
      },
    });
    const service = new PublisherBindingRefreshService(
      db as never,
      {} as never,
      { getBotId: () => botId, getRequiredActionToken: () => 'synthetic' } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const terminal = service as unknown as {
      completeCandidateTerminal(
        job: PublisherBindingRefreshJob,
        outcome: { reason: string },
      ): Promise<void>;
    };
    const membership = await pool.connect();
    let completion: Promise<{ error: unknown }> | undefined;
    try {
      await membership.query('BEGIN');
      await membership.query('SELECT id FROM chats WHERE id = $1 FOR UPDATE', [chatId]);
      // The actual loss trigger retains the binding until this membership transaction commits.
      await membership.query(
        `INSERT INTO chat_membership_activity_events
          (id, dedupe_key, chat_id, event_type, user_id, bot_id, event_at)
          VALUES ($1, $1, $2, 'user_removed', $3, $4, $5)`,
        [activityId, chatId, userId, botId, eventAt],
      );
      completion = terminal
        .completeCandidateTerminal(
          {
            version: 1,
            chatId,
            publisherBotId: botId,
            candidateUserId: userId,
            candidateVersion,
            reason: 'forwarded_private',
            requestedAt: eventAt.toISOString(),
          },
          { reason: 'publisher_user_not_admin' },
        )
        .then(
          () => ({ error: null }),
          (error: unknown) => ({ error }),
        );
      await waitForBlockedTerminal();

      // Edge-first completion holds this row while waiting for the binding above, which
      // creates a deadlock when membership continues. NOWAIT detects that exact inversion.
      const availableEdge = await membership.query(
        `SELECT chat_id FROM managed_entity_access_edges
          WHERE chat_id = $1 AND user_id = $2 AND bot_id = $3 FOR UPDATE NOWAIT`,
        [chatId, userId, botId],
      );
      expect(availableEdge.rowCount).toBe(1);
      await membership.query(
        `UPDATE managed_entity_access_edges
          SET state = 'USER_DENIED', user_role = 'MEMBER', bot_role = 'UNKNOWN',
            checked_at = $4, expires_at = NULL, denied_reason = 'webhook_user_removed',
            source = 'webhook_user_removed'
          WHERE chat_id = $1 AND user_id = $2 AND bot_id = $3`,
        [chatId, userId, botId, eventAt],
      );
      await membership.query('COMMIT');
      expect((await completion).error).toBeInstanceOf(PublisherCandidateRefreshSupersededError);
      const edge = await db.managedEntityAccessEdge.findUniqueOrThrow({
        where: { chatId_userId_botId: { chatId, userId, botId } },
      });
      expect(edge.state).toBe('USER_DENIED');
      expect(edge.source).toBe('webhook_user_removed');
      expect(edge.checkedAt).toEqual(eventAt);
      await db.marketplaceBinding.update({
        where: { id: bindingId },
        data: { state: 'ACTIVE', checkedAt: new Date(eventAt.getTime() + 1_000) },
      });
      expect(
        (await db.marketplaceBinding.findUniqueOrThrow({ where: { id: bindingId } }))
          .lastButtonAccessLossAt,
      ).toEqual(eventAt);
    } finally {
      await membership.query('ROLLBACK').catch(() => undefined);
      membership.release();
      await completion;
    }
  });
});
