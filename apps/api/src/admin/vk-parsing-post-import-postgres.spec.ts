import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import type { Prisma } from '../prisma/prisma-client';
import {
  VkParsingPostImportRepository,
  type PreparedVkPostImport,
  type VkParsingPostImportDatabase,
} from './vk-parsing-post-import.repository';
import { lockVkSyncLease, VkSyncLeaseLostError, type VkSyncLease } from './vk-sync-lease';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('PostgreSQL VK import storage', () => {
  let client: Client;
  let repository: VkParsingPostImportRepository;
  let database: VkParsingPostImportDatabase;
  let toastTable: string;
  let leaseSchema: string;
  let contender: Client;
  let lastLeaseQuery: Prisma.Sql;
  const leaseDatabase = {
    $queryRaw: async (query: Prisma.Sql) => {
      lastLeaseQuery = query;
      return (await client.query(query.text, query.values)).rows;
    },
  };
  const source = {
    id: 'storage-source',
    chatId: 'storage-chat',
    wallOwnerId: -123,
    ownerProfile: 'PUBLISHER' as const,
    ownerBotId: 'storage-bot',
  };
  const lease: VkSyncLease = { ...source, syncLockedBy: 'attempt-a', syncAttemptCount: 1 };
  let imported: PreparedVkPostImport;

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    ) {
      throw new Error('Storage tests require a local disposable race_test database');
    }
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    leaseSchema = `vk_sync_lease_${randomBytes(6).toString('hex')}`;
    await client.query(`CREATE SCHEMA "${leaseSchema}"`);
    await client.query(
      `CREATE TABLE "${leaseSchema}".vk_parsing_sources (LIKE public.vk_parsing_sources INCLUDING ALL)`,
    );
    await client.query(`SET search_path TO "${leaseSchema}", pg_temp, public`);
    contender = new Client({ connectionString: databaseUrl });
    await contender.connect();
    await contender.query(`SET search_path TO "${leaseSchema}", public`);
    await contender.query("SET lock_timeout TO '100ms'");
    expect(
      Number((await client.query('SHOW server_version_num')).rows[0].server_version_num),
    ).toBeGreaterThanOrEqual(160000);
    // Actual production columns/indexes, isolated temp table: no production rows or FK mutations.
    await client.query(
      'CREATE TEMP TABLE vk_parsing_posts (LIKE public.vk_parsing_posts INCLUDING ALL)',
    );
    await client.query(
      'ALTER TABLE pg_temp.vk_parsing_posts ALTER COLUMN raw SET STORAGE EXTERNAL',
    );
    const toast = await client.query(
      "SELECT reltoastrelid::regclass::text AS name FROM pg_class WHERE oid = 'pg_temp.vk_parsing_posts'::regclass",
    );
    toastTable = toast.rows[0].name;
    database = {
      $executeRaw: async (query: Prisma.Sql) =>
        (await client.query(query.text, query.values)).rowCount,
    } as unknown as VkParsingPostImportDatabase;
  });

  beforeEach(async () => {
    await client.query(`TRUNCATE "${leaseSchema}".vk_parsing_sources`);
    await client.query(
      `INSERT INTO "${leaseSchema}".vk_parsing_sources (
      id, chat_id, owner_profile, owner_bot_id, owner_id, wall_owner_id,
      screen_name, title, url, created_by_user_id, updated_at,
      sync_status, sync_locked_by, sync_attempt_count, sync_lock_deadline_at
    ) VALUES ($1, $2, 'PUBLISHER', $3, 123, -123, 'storage', 'Storage',
      'https://vk.com/storage', 'test-user', now(), 'SYNCING', $4, 1,
      (clock_timestamp() AT TIME ZONE 'UTC') + interval '2 minutes')`,
      [source.id, source.chatId, source.ownerBotId, lease.syncLockedBy],
    );
    await client.query('TRUNCATE pg_temp.vk_parsing_posts');
    repository = new VkParsingPostImportRepository(database as never);
    imported = {
      status: 'NEW',
      publishScheduleFingerprint: null,
      post: {
        vkOwnerId: -123,
        vkPostId: 1,
        vkPublishedAt: new Date('2026-09-01T00:00:00Z'),
        text: 'original',
        textFormat: 'plain',
        url: 'https://vk.com/wall-123_1',
        photoUrls: ['https://example.test/photo'],
        videoUrls: [],
        linkUrls: [],
        attachments: [],
        attachmentTypes: [],
        unsupportedAttachments: [],
        hasUnsupportedAttachments: false,
        isAdvertising: false,
        advertisingMarkers: [],
        raw: { content: randomBytes(128 * 1024).toString('base64'), views: 1 },
        contentHash: 'revision-1',
      },
    };
  });

  afterAll(async () => {
    await contender?.end();
    if (leaseSchema) await client.query(`DROP SCHEMA IF EXISTS "${leaseSchema}" CASCADE`);
    await client?.end();
  });

  it('blocks a reclaim while an import holds the generation lock, then fences its old worker', async () => {
    await client.query('BEGIN');
    try {
      await lockVkSyncLease(leaseDatabase as never, lease);
      await expect(
        contender.query(
          `UPDATE "${leaseSchema}".vk_parsing_sources
        SET sync_locked_by = 'attempt-b', sync_attempt_count = 2 WHERE id = $1`,
          [source.id],
        ),
      ).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await client.query('ROLLBACK');
    }
    await contender.query(
      `UPDATE "${leaseSchema}".vk_parsing_sources
      SET sync_locked_by = 'attempt-b', sync_attempt_count = 2 WHERE id = $1`,
      [source.id],
    );
    imported.post.text = 'new generation';
    imported.post.contentHash = 'new-generation';
    await repository.persistImportedPosts(source, [imported], new Date());
    const before = await heapIdentity();

    await client.query('BEGIN');
    try {
      await expect(lockVkSyncLease(leaseDatabase as never, lease)).rejects.toBeInstanceOf(
        VkSyncLeaseLostError,
      );
    } finally {
      await client.query('ROLLBACK');
    }
    expect(await heapIdentity()).toEqual(before);
    expect((await client.query('SELECT text FROM pg_temp.vk_parsing_posts')).rows[0].text).toBe(
      'new generation',
    );
    await expect(
      lockVkSyncLease(leaseDatabase as never, {
        ...lease,
        syncLockedBy: 'attempt-b',
        syncAttemptCount: 2,
      }),
    ).resolves.toBeUndefined();
  });

  it.each(['expired', 'import-disabled', 'inactive', 'generation-changed'] as const)(
    'rejects a %s lease before any import or missing-state effects',
    async (kind) => {
      const change = {
        expired:
          "sync_lock_deadline_at = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second'",
        'import-disabled': 'import_enabled = FALSE',
        inactive: "status = 'PAUSED'",
        'generation-changed': 'sync_attempt_count = 2',
      }[kind];
      await client.query(`UPDATE "${leaseSchema}".vk_parsing_sources SET ${change} WHERE id = $1`, [
        source.id,
      ]);

      await expect(lockVkSyncLease(leaseDatabase as never, lease)).rejects.toBeInstanceOf(
        VkSyncLeaseLostError,
      );
    },
  );

  it('checks expiry after acquiring a contended row lock rather than at statement start', async () => {
    await client.query(
      `UPDATE "${leaseSchema}".vk_parsing_sources
      SET sync_lock_deadline_at = (clock_timestamp() AT TIME ZONE 'UTC') + interval '200 milliseconds'
      WHERE id = $1`,
      [source.id],
    );
    await contender.query('BEGIN');
    await contender.query(
      `SELECT id FROM "${leaseSchema}".vk_parsing_sources WHERE id = $1 FOR UPDATE`,
      [source.id],
    );
    const outcome = lockVkSyncLease(leaseDatabase as never, lease).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      await contender.query('ROLLBACK');
    }
    expect(await outcome).toBeInstanceOf(VkSyncLeaseLostError);
  });

  it('uses an indexed source lookup with ten thousand other sources', async () => {
    await client.query(`INSERT INTO "${leaseSchema}".vk_parsing_sources (
      id, chat_id, owner_profile, owner_bot_id, owner_id, wall_owner_id,
      screen_name, title, url, created_by_user_id, updated_at
    ) SELECT 'history-' || n, 'chat-' || n, 'PUBLISHER', 'bot-' || n,
      n, -n, 'history', 'History', 'https://vk.com/history', 'test-user', now()
      FROM generate_series(1000, 10999) AS n`);
    await client.query(`ANALYZE "${leaseSchema}".vk_parsing_sources`);
    await lockVkSyncLease(leaseDatabase as never, lease);
    const plan = (
      await client.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${lastLeaseQuery.text}`,
        lastLeaseQuery.values,
      )
    ).rows[0]['QUERY PLAN'][0].Plan;
    const nodes: Array<Record<string, unknown>> = [];
    const walk = (node: Record<string, unknown>) => {
      nodes.push(node);
      for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>) walk(child);
    };
    walk(plan);
    expect(nodes.some((node) => node['Node Type'] === 'Index Scan')).toBe(true);
    expect(nodes.some((node) => node['Node Type'] === 'Seq Scan')).toBe(false);
    expect(plan['Actual Rows']).toBe(1);
    expect(
      Number(plan['Shared Hit Blocks'] ?? 0) + Number(plan['Shared Read Blocks'] ?? 0),
    ).toBeLessThan(20);
  });

  async function toastChunks() {
    // Name comes only from this connection's temp relation in pg_class.
    return (
      await client.query(
        `SELECT chunk_id, chunk_seq FROM ${toastTable} ORDER BY chunk_id, chunk_seq`,
      )
    ).rows;
  }

  async function heapIdentity() {
    return (
      await client.query('SELECT xmin::text, ctid::text, updated_at FROM pg_temp.vk_parsing_posts')
    ).rows[0];
  }

  it('skips exact observation replays without rewriting the heap or its TOAST payload', async () => {
    const observed = new Date('2026-09-01T00:00:00Z');
    await repository.persistImportedPosts(source, [imported], observed);
    const before = await heapIdentity();
    const beforeToast = await toastChunks();

    for (let index = 0; index < 100; index++) {
      await repository.persistImportedPosts(source, [imported], observed);
    }

    expect(await heapIdentity()).toEqual(before);
    expect(await toastChunks()).toEqual(beforeToast);
    expect(repository.getPersistenceSnapshot()).toEqual(
      expect.objectContaining({
        batches: 101,
        postsAttempted: 101,
        rowsWritten: 1,
        rowsSkippedOrFenced: 100,
        failedBatches: 0,
      }),
    );
  });

  it('reuses existing TOAST chunks while advancing observation timestamps', async () => {
    await repository.persistImportedPosts(source, [imported], new Date('2026-09-01T00:00:00Z'));
    const beforeHeap = await heapIdentity();
    const before = await toastChunks();
    expect(before.length).toBeGreaterThan(20);
    const observed = new Date('2026-09-01T00:05:00Z');
    for (let i = 0; i < 5; i++) await repository.persistImportedPosts(source, [imported], observed);
    expect(await heapIdentity()).not.toEqual(beforeHeap);
    expect(await toastChunks()).toEqual(before);
    const row = (
      await client.query(
        'SELECT raw, last_seen_at, last_availability_checked_at FROM pg_temp.vk_parsing_posts',
      )
    ).rows[0];
    expect(row.raw).toEqual(imported.post.raw);
    expect(row.last_seen_at).toEqual(observed);
    expect(row.last_availability_checked_at).toEqual(observed);
    expect(repository.getPersistenceSnapshot().rowsWritten).toBe(2);
    expect(repository.getPersistenceSnapshot().rowsSkippedOrFenced).toBe(4);
  });

  it('persists changed raw counters and URLs even when the content hash is unchanged', async () => {
    const observed = new Date('2026-09-01T00:00:00Z');
    await repository.persistImportedPosts(source, [imported], observed);
    const before = await toastChunks();
    imported.post.raw = { ...imported.post.raw, views: 2 };
    imported.post.photoUrls = ['https://example.test/refreshed'];
    await repository.persistImportedPosts(source, [imported], observed);
    expect(await toastChunks()).not.toEqual(before);
    const row = (await client.query('SELECT raw, photo_urls FROM pg_temp.vk_parsing_posts'))
      .rows[0];
    expect(row.raw.views).toBe(2);
    expect(row.photo_urls).toEqual(imported.post.photoUrls);
    expect(repository.getPersistenceSnapshot().rowsWritten).toBe(2);
  });

  it('preserves manual content and active publication revision fences', async () => {
    const observed = new Date('2026-09-01T00:00:00Z');
    await repository.persistImportedPosts(source, [imported], observed);
    await client.query(
      "UPDATE pg_temp.vk_parsing_posts SET text = 'manual', photo_urls = '[\"manual-photo\"]', manual_content_edited_at = now()",
    );
    const manuallyEditedHeap = await heapIdentity();
    await repository.persistImportedPosts(source, [imported], observed);
    expect(await heapIdentity()).toEqual(manuallyEditedHeap);
    expect(
      (await client.query('SELECT text, photo_urls FROM pg_temp.vk_parsing_posts')).rows[0],
    ).toEqual({ text: 'manual', photo_urls: ['manual-photo'] });
    await client.query(
      "UPDATE pg_temp.vk_parsing_posts SET publish_idempotency_key = 'active-attempt'",
    );
    const publicationHeap = await heapIdentity();
    imported.post.contentHash = 'revision-2';
    imported.post.raw = { views: 999 };
    await repository.persistImportedPosts(source, [imported], new Date('2026-09-01T00:05:00Z'));
    expect(await heapIdentity()).toEqual(publicationHeap);
    const row = (await client.query('SELECT content_hash, raw, text FROM pg_temp.vk_parsing_posts'))
      .rows[0];
    expect(row.content_hash).toBe('revision-1');
    expect(row.raw.views).toBe(1);
    expect(row.text).toBe('manual');
    expect(repository.getPersistenceSnapshot().rowsWritten).toBe(1);
    expect(repository.getPersistenceSnapshot().rowsSkippedOrFenced).toBe(2);
  });

  it('replaces manually edited fields when VK content changes at the same observation time', async () => {
    const observed = new Date('2026-09-01T00:00:00Z');
    await repository.persistImportedPosts(source, [imported], observed);
    await client.query(
      "UPDATE pg_temp.vk_parsing_posts SET text = 'manual', photo_urls = '[\"manual-photo\"]', manual_content_edited_at = now()",
    );
    imported.post.contentHash = 'revision-2';
    imported.post.text = 'changed in VK';
    imported.post.photoUrls = ['https://example.test/revision-2'];

    await repository.persistImportedPosts(source, [imported], observed);

    expect(
      (
        await client.query(
          'SELECT text, photo_urls, manual_content_edited_at, content_hash FROM pg_temp.vk_parsing_posts',
        )
      ).rows[0],
    ).toEqual({
      text: 'changed in VK',
      photo_urls: imported.post.photoUrls,
      manual_content_edited_at: null,
      content_hash: 'revision-2',
    });
  });

  it('clears missing and unavailable observations even when the incoming snapshot is identical', async () => {
    const observed = new Date('2026-09-01T00:00:00Z');
    await repository.persistImportedPosts(source, [imported], observed);
    await client.query(
      'UPDATE pg_temp.vk_parsing_posts SET missing_since_at = now(), missing_seen_count = 2, unavailable_at = now()',
    );
    const before = await heapIdentity();

    await repository.persistImportedPosts(source, [imported], observed);

    expect(await heapIdentity()).not.toEqual(before);
    expect(
      (
        await client.query(
          'SELECT missing_since_at, missing_seen_count, unavailable_at FROM pg_temp.vk_parsing_posts',
        )
      ).rows[0],
    ).toEqual({ missing_since_at: null, missing_seen_count: 0, unavailable_at: null });
  });

  it('clears stale skip and publication errors on NEW posts without changing the observation time', async () => {
    const observed = new Date('2026-09-01T00:00:00Z');
    await repository.persistImportedPosts(source, [imported], observed);
    await client.query(
      "UPDATE pg_temp.vk_parsing_posts SET skipped_at = now(), skip_reason = 'previous', auto_publish_error = 'previous', last_error = 'previous'",
    );

    await repository.persistImportedPosts(source, [imported], observed);

    expect(
      (
        await client.query(
          'SELECT skipped_at, skip_reason, auto_publish_error, last_error FROM pg_temp.vk_parsing_posts',
        )
      ).rows[0],
    ).toEqual({ skipped_at: null, skip_reason: null, auto_publish_error: null, last_error: null });
  });

  it('preserves skip and publication errors on a replay of a non-NEW post', async () => {
    const observed = new Date('2026-09-01T00:00:00Z');
    imported.status = 'FAILED';
    await repository.persistImportedPosts(source, [imported], observed);
    await client.query(
      "UPDATE pg_temp.vk_parsing_posts SET skipped_at = now(), skip_reason = 'previous', auto_publish_error = 'previous', last_error = 'previous'",
    );
    const before = await heapIdentity();

    await repository.persistImportedPosts(source, [imported], observed);

    expect(await heapIdentity()).toEqual(before);
    expect(
      (
        await client.query(
          'SELECT skip_reason, auto_publish_error, last_error FROM pg_temp.vk_parsing_posts',
        )
      ).rows[0],
    ).toEqual({ skip_reason: 'previous', auto_publish_error: 'previous', last_error: 'previous' });
  });
});
