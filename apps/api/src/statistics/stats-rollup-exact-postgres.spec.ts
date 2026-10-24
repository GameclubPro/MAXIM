import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { PrismaClient, createPrismaAdapter } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { selectChannelStatsContentBucketRows } from '../admin/stats-read-model-selectors';
import { toSafeInteger } from '../admin/admin-statistics-values';

const databaseUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim() || '';
const native = databaseUrl ? describe : describe.skip;
const migration = readFileSync(
  resolve(
    __dirname,
    '../../prisma/migrations/20261024020000_add_exact_channel_statistics_views/migration.sql',
  ),
  'utf8',
);
native('native exact rollup online evolution', () => {
  let db: PrismaClient;
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local database required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 3, statement_timeout: 15_000 }),
    });
  });
  afterAll(async () => db?.$disconnect());

  it('adds nullable counters without changing the retained heap or backfilling old rows', async () => {
    const client = new Client({ connectionString: databaseUrl });
    const schema = `rollup_${randomUUID().replaceAll('-', '')}`;
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema},public;
        CREATE TABLE channel_stats_bucket_rollups(chat_id text NOT NULL,bucket_start timestamp(3) NOT NULL,posts int NOT NULL DEFAULT 0,views_total int NOT NULL DEFAULT 0,views_delta int NOT NULL DEFAULT 0,reactions int NOT NULL DEFAULT 0,updated_at timestamp(3) NOT NULL DEFAULT now(),PRIMARY KEY(chat_id,bucket_start));
        INSERT INTO channel_stats_bucket_rollups(chat_id,bucket_start,views_total,views_delta) VALUES('old', '2026-10-01 12:00:00',7,9);`);
      const before = (
        await client.query(
          "SELECT relfilenode FROM pg_class WHERE oid='channel_stats_bucket_rollups'::regclass",
        )
      ).rows[0].relfilenode;
      await client.query(migration);
      const after = (
        await client.query(
          "SELECT relfilenode FROM pg_class WHERE oid='channel_stats_bucket_rollups'::regclass",
        )
      ).rows[0].relfilenode;
      expect(after).toBe(before);
      expect(
        (
          await client.query(
            'SELECT views_total,views_delta,views_total_exact,views_delta_exact FROM channel_stats_bucket_rollups',
          )
        ).rows,
      ).toEqual([
        { views_total: 7, views_delta: 9, views_total_exact: null, views_delta_exact: null },
      ]);
      expect(
        (
          await client.query(
            'SELECT SUM(COALESCE(views_total_exact,views_total::bigint)) AS value FROM channel_stats_bucket_rollups',
          )
        ).rows[0].value,
      ).toBe('7');
      await client.query(
        "SELECT apply_channel_stats_post_bucket_delta('old','2026-10-01 12:00:00',0,2147483647,0)",
      );
      expect(
        (
          await client.query(
            'SELECT views_total,views_total_exact FROM channel_stats_bucket_rollups',
          )
        ).rows[0],
      ).toEqual({ views_total: 2147483647, views_total_exact: '2147483654' });
      await client.query(
        "SELECT apply_channel_stats_post_bucket_delta('old','2026-10-01 12:00:00',0,-2147483647,0)",
      );
      expect(
        (
          await client.query(
            'SELECT views_total,views_total_exact FROM channel_stats_bucket_rollups',
          )
        ).rows[0],
      ).toEqual({ views_total: 7, views_total_exact: '7' });
      await client.query(
        "SELECT apply_channel_stats_post_bucket_delta('absent','2026-10-01 12:00:00',0,-2147483647,0)",
      );
      expect(
        (
          await client.query(
            "SELECT views_total_exact FROM channel_stats_bucket_rollups WHERE chat_id='absent'",
          )
        ).rows[0].views_total_exact,
      ).toBe('0');
    } finally {
      await client.query('ROLLBACK');
      await client.query('SET search_path TO public');
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
      await client.end();
    }
  });

  it('keeps both same-hour trigger sums exact and reads new and untouched old buckets once', async () => {
    const chatId = `-${BigInt('0x' + randomUUID().replaceAll('-', '').slice(0, 15)) + 1n}`;
    const hour = new Date(Date.now() - 48 * 3600_000);
    hour.setUTCMinutes(0, 0, 0);
    await db.chat.create({
      data: { id: chatId, title: 'Exact native counters', entityType: 'CHANNEL' },
    });
    try {
      await db.channelStatsBucketRollup.create({
        data: {
          chatId,
          bucketStart: new Date(hour.getTime() - 3600_000),
          viewsTotal: 17,
          viewsDelta: 23,
        },
      });
      const posts = [];
      for (const id of ['one', 'two']) {
        const post = await db.channelPost.create({
          data: { chatId, messageId: id, publishedAt: hour, latestViews: 2147483647 },
        });
        posts.push(post);
        await db.channelPostViewSnapshot.create({
          data: { channelPostId: post.id, views: 0, capturedAt: hour },
        });
        await db.channelPostViewSnapshot.create({
          data: {
            channelPostId: post.id,
            views: 2147483647,
            capturedAt: new Date(hour.getTime() + 1000),
          },
        });
      }
      const bucket = await db.channelStatsBucketRollup.findUniqueOrThrow({
        where: { chatId_bucketStart: { chatId, bucketStart: hour } },
      });
      expect(bucket).toMatchObject({
        viewsTotal: 2147483647,
        viewsDelta: 2147483647,
        viewsTotalExact: 4294967294n,
        viewsDeltaExact: 4294967294n,
      });
      const selected = await selectChannelStatsContentBucketRows(db as PrismaService, {
        chatId,
        from: new Date(hour.getTime() - 3600_000),
        to: new Date(hour.getTime() + 3600_000),
        bucket: 'hour',
      });
      expect(selected.map((row) => toSafeInteger(row.views_delta))).toEqual([17, 4294967294]);
      await db.channelPost.update({ where: { id: posts[0]!.id }, data: { latestViews: 0 } });
      expect(
        (
          await db.channelStatsBucketRollup.findUniqueOrThrow({
            where: { chatId_bucketStart: { chatId, bucketStart: hour } },
          })
        ).viewsTotalExact,
      ).toBe(2147483647n);
    } finally {
      await db.chat.delete({ where: { id: chatId } });
    }
  });
});
