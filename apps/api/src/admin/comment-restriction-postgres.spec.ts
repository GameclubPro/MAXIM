import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPrismaClient, type PrismaClient } from '../prisma/prisma-client';
import {
  commentRestrictionKey,
  lockCommentParticipant,
  withCommentWrite,
  type CommentScope,
} from './comment-restriction-store';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describeDatabase = databaseUrl ? describe : describe.skip;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describeDatabase('PostgreSQL comment restriction serialization', () => {
  let writer: PrismaClient;
  let reader: PrismaClient;
  let pool: Pool;
  const scope: CommentScope = {
    profile: 'publisher',
    entityType: 'channel',
    chatId: `comment-race-${randomUUID()}`,
  };
  const applicationName = `comment-race-${randomUUID()}`;
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Comment races require a disposable local race_test database');
    writer = createPrismaClient(databaseUrl, { max: 1, statement_timeout: 10_000 });
    reader = createPrismaClient(databaseUrl, {
      max: 1,
      statement_timeout: 10_000,
      application_name: applicationName,
    });
    pool = new Pool({ connectionString: databaseUrl, max: 1, statement_timeout: 5000 });
  });
  afterEach(async () => {
    await writer?.commentRestriction.deleteMany({ where: { chatId: scope.chatId } });
  });
  afterAll(async () => {
    await writer?.$disconnect();
    await reader?.$disconnect();
    await pool?.end();
  });

  async function waitForBlockedReader() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await pool.query<{ blocked: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND cardinality(pg_blocking_pids(pid)) > 0) AS blocked',
        [applicationName],
      );
      if (result.rows[0]?.blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Comment writer did not wait for the sanction lock');
  }

  it('blocks a send until the first-ever ban commits, then rejects the send', async () => {
    const locked = deferred();
    const release = deferred();
    const key = commentRestrictionKey(scope, 'reader');
    const banning = writer.$transaction(
      async (tx) => {
        await lockCommentParticipant(tx, scope, 'reader');
        await tx.commentRestriction.create({ data: { ...key, kind: 'BAN', revision: 1 } });
        locked.resolve();
        await release.promise;
      },
      { timeout: 10_000 },
    );
    let send: Promise<unknown> | undefined;
    const persist = jest.fn();
    try {
      await Promise.race([locked.promise, banning]);
      send = withCommentWrite(reader, scope, 'reader', persist).catch((error: unknown) => error);
      await waitForBlockedReader();
      expect(persist).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await banning;
    }
    expect(await send).toMatchObject({
      response: expect.objectContaining({ code: 'COMMENT_RESTRICTED' }),
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it('does not block another profile and admits writes after expiry without a cleanup job', async () => {
    await writer.commentRestriction.create({
      data: { ...commentRestrictionKey(scope, 'reader'), kind: 'BAN', revision: 1 },
    });
    await expect(
      withCommentWrite(reader, { ...scope, profile: 'moderation' }, 'reader', async () => 'saved'),
    ).resolves.toBe('saved');
    await writer.commentRestriction.update({
      where: { profile_entityType_chatId_userId: commentRestrictionKey(scope, 'reader') },
      data: { kind: 'MUTE', expiresAt: new Date(0) },
    });
    await expect(withCommentWrite(reader, scope, 'reader', async () => 'saved')).resolves.toBe(
      'saved',
    );
  });
});
