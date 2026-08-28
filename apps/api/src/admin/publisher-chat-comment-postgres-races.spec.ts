import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPrismaClient, type Prisma, type PrismaClient } from '../prisma/prisma-client';
import {
  buildPublisherChatCommentCountQuery,
  buildPublisherChatCommentsQuery,
  mutatePublisherChatCommentWithLock,
} from './publisher-chat-comment-store';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgresRace = databaseUrl ? describe : describe.skip;

jest.setTimeout(30_000);

function assertDisposableDatabaseUrl(value: string): void {
  const parsed = new URL(value);
  const databaseName = parsed.pathname.replace(/^\//u, '');
  if (
    !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname) ||
    !databaseName.includes('race_test')
  ) {
    throw new Error(
      'CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL must target a local database containing race_test',
    );
  }
}

function readPayload(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function collectExplainNodes(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.flatMap(collectExplainNodes);
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  const record = value as Record<string, unknown>;
  return [record, ...Object.values(record).flatMap(collectExplainNodes)];
}

async function waitForBlockedApplicationBackend(
  pool: Pool,
  applicationName: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ blocked: boolean }>(
      `SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity activity
        WHERE activity.application_name = $1
          AND cardinality(pg_blocking_pids(activity.pid)) > 0
      ) AS blocked`,
      [applicationName],
    );
    if (result.rows[0]?.blocked === true) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`PostgreSQL application ${applicationName} did not become lock-blocked`);
}

describePostgresRace('PostgreSQL Publisher chat comment races', () => {
  let pool: Pool;
  let editPrisma: PrismaClient;
  let reactionPrisma: PrismaClient;
  let chatId: string;
  let messageId: string;
  let threadId: string;

  beforeAll(async () => {
    assertDisposableDatabaseUrl(databaseUrl);
    pool = new Pool({
      connectionString: databaseUrl,
      max: 3,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
    });
    editPrisma = createPrismaClient(databaseUrl, {
      application_name: 'publisher-comment-edit-race',
      max: 1,
      statement_timeout: 10_000,
    });
    reactionPrisma = createPrismaClient(databaseUrl, {
      application_name: 'publisher-comment-reaction-race',
      max: 1,
      statement_timeout: 10_000,
    });
    await Promise.all([editPrisma.$connect(), reactionPrisma.$connect()]);

    const database = await pool.query<{ databaseName: string; serverVersion: string }>(
      `SELECT current_database() AS "databaseName", version() AS "serverVersion"`,
    );
    expect(database.rows[0]?.databaseName).toContain('race_test');
    expect(database.rows[0]?.serverVersion).toMatch(/^PostgreSQL /u);
    const index = await pool.query<{ present: boolean }>(
      `SELECT to_regclass('public.audit_logs_publisher_chat_comment_thread_created_idx')
        IS NOT NULL AS present`,
    );
    expect(index.rows[0]?.present).toBe(true);
  });

  beforeEach(async () => {
    const suffix = randomUUID();
    chatId = `publisher-comment-race-chat-${suffix}`;
    messageId = `publisher-comment-race-message-${suffix}`;
    threadId = `publisher-comment-race-thread-${suffix}`;
    await pool.query(
      `INSERT INTO chats (
        id, title, entity_type, catalog_kind, routing_state, routing_version, updated_at
      ) VALUES ($1, 'Publisher comment race', 'CHAT', 'MANAGED', 'READY', 0, CURRENT_TIMESTAMP)`,
      [chatId],
    );
    await pool.query(
      `INSERT INTO audit_logs (id, chat_id, actor_user_id, action, payload, created_at)
      VALUES ($1, $2, 'author-race', 'PUBLISHER_CHAT_DIALOG_COMMENT', $3::jsonb, CURRENT_TIMESTAMP)`,
      [
        messageId,
        chatId,
        JSON.stringify({
          type: 'comments',
          threadId,
          text: 'Исходный текст',
          reactions: [],
          publisherProfile: true,
        }),
      ],
    );
  });

  afterEach(async () => {
    await pool.query('DELETE FROM audit_logs WHERE id = $1', [messageId]);
    await pool.query('DELETE FROM chats WHERE id = $1', [chatId]);
  });

  afterAll(async () => {
    await Promise.all([editPrisma?.$disconnect(), reactionPrisma?.$disconnect()]);
    await pool?.end();
  });

  it('keeps both an edit and a reaction when their read-modify-write windows overlap', async () => {
    let releaseEdit = (): void => undefined;
    let markEditLocked = (): void => undefined;
    const editRelease = new Promise<void>((resolve) => {
      releaseEdit = resolve;
    });
    const editLocked = new Promise<void>((resolve) => {
      markEditLocked = resolve;
    });
    let editMutation: Promise<unknown> | null = null;
    let reactionMutation: Promise<unknown> | null = null;

    try {
      editMutation = mutatePublisherChatCommentWithLock(
        editPrisma,
        { chatId, messageId, threadId },
        async (row) => {
          markEditLocked();
          await editRelease;
          return {
            ...readPayload(row.payload),
            text: 'Отредактированный текст',
            editedAt: '2026-08-28T12:00:00.000Z',
          };
        },
      );
      await editLocked;

      reactionMutation = mutatePublisherChatCommentWithLock(
        reactionPrisma,
        { chatId, messageId, threadId },
        (row) => ({
          ...readPayload(row.payload),
          reactions: [{ emoji: 'like', userIds: ['reactor-race'] }],
        }),
      );
      await waitForBlockedApplicationBackend(pool, 'publisher-comment-reaction-race');

      releaseEdit();
      await Promise.all([editMutation, reactionMutation]);

      const stored = await pool.query<{ payload: Record<string, unknown> }>(
        'SELECT payload FROM audit_logs WHERE id = $1',
        [messageId],
      );
      expect(stored.rows[0]?.payload).toEqual(
        expect.objectContaining({
          text: 'Отредактированный текст',
          editedAt: '2026-08-28T12:00:00.000Z',
          reactions: [{ emoji: 'like', userIds: ['reactor-race'] }],
        }),
      );
    } finally {
      releaseEdit();
      await Promise.allSettled([editMutation, reactionMutation].filter(Boolean));
    }
  });

  it('uses the Publisher thread expression index for the bounded dialog read', async () => {
    const query = buildPublisherChatCommentsQuery(chatId, threadId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query('SET LOCAL enable_seqscan = off');
      await client.query('SET LOCAL enable_bitmapscan = off');
      const plan = await client.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON, COSTS FALSE) ${query.text}`,
        query.values,
      );
      const indexNames = collectExplainNodes(plan.rows[0]?.['QUERY PLAN']).flatMap((node) =>
        typeof node['Index Name'] === 'string' ? [node['Index Name']] : [],
      );
      expect(indexNames).toContain('audit_logs_publisher_chat_comment_thread_created_idx');

      const countQuery = buildPublisherChatCommentCountQuery(chatId, threadId);
      const countPlan = await client.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON, COSTS FALSE) ${countQuery.text}`,
        countQuery.values,
      );
      const countIndexNames = collectExplainNodes(countPlan.rows[0]?.['QUERY PLAN']).flatMap(
        (node) => (typeof node['Index Name'] === 'string' ? [node['Index Name']] : []),
      );
      expect(countIndexNames).toContain('audit_logs_publisher_chat_comment_thread_created_idx');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
