import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';

const databaseUrl =
  process.env.MAXIM_TEST_POSTGRES_URL?.trim() ||
  process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ||
  '';
const describePostgres = databaseUrl ? describe : describe.skip;
const migrationRoot = resolve(__dirname, '../../prisma/migrations');
const original = readFileSync(
  resolve(migrationRoot, '20260524120000_optimize_stats_read_models/migration.sql'),
  'utf8',
);
const functionStart = original.indexOf(
  'CREATE OR REPLACE FUNCTION "sync_chat_moderation_stats_rollup"()',
);
const functionEnd =
  original.indexOf('$$ LANGUAGE plpgsql;', functionStart) + '$$ LANGUAGE plpgsql;'.length;
const originalFunction = original.slice(functionStart, functionEnd);
const optimizedMigration = readFileSync(
  resolve(migrationRoot, '20261001190000_skip_exact_moderation_rollup_rewrites/migration.sql'),
  'utf8',
);
const tables = [
  'moderation_events',
  'chat_moderation_stats_rollups',
  'chat_moderation_affected_user_hours',
  'chat_moderation_feed_items',
] as const;
type Event = {
  id: string;
  user?: string;
  action?: string;
  rule?: string;
  at?: string;
  eventType?: string;
  metadata?: unknown;
  chat?: string;
};

describePostgres('PostgreSQL conservative moderation rollup optimization', () => {
  let client: Client;
  let legacySchema: string;
  let optimizedSchema: string;
  const schemas: string[] = [];

  async function connect(schema?: string) {
    const connection = new Client({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 3_000,
      statement_timeout: 5_000,
      lock_timeout: 3_000,
    });
    await connection.connect();
    await connection.query("SET TIME ZONE 'UTC'");
    if (schema) await connection.query(`SET search_path TO "${schema}", public`);
    return connection;
  }

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Rollup tests require a local disposable race_test database');
    client = await connect();
    const version = Number(
      (await client.query('SHOW server_version_num')).rows[0].server_version_num,
    );
    expect(version).toBeGreaterThanOrEqual(160000);
    expect(version).toBeLessThan(170000);
  });

  beforeEach(async () => {
    legacySchema = `rollup_old_${randomUUID().replaceAll('-', '')}`;
    optimizedSchema = `rollup_new_${randomUUID().replaceAll('-', '')}`;
    for (const schema of [legacySchema, optimizedSchema]) {
      schemas.push(schema);
      await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}", public`);
      // FLAG: LIKE copies production types/defaults/indexes, not FK or triggers.
      // Every write/trigger below resolves exclusively inside this random schema.
      for (const table of tables)
        await client.query(
          `CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`,
        );
      await client.query(schema === legacySchema ? originalFunction : optimizedMigration);
      await client.query(`CREATE TRIGGER moderation_events_stats_rollup_insert
        AFTER INSERT ON moderation_events FOR EACH ROW
        EXECUTE FUNCTION sync_chat_moderation_stats_rollup()`);
    }
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
    for (const schema of schemas.splice(0))
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  });
  afterAll(async () => {
    await client?.end();
  });

  async function insert(connection: Client, schema: string, event: Event, replay = false) {
    await connection.query(`SET LOCAL search_path TO "${schema}", public`);
    return connection.query(
      `INSERT INTO "${schema}".moderation_events (
        id, chat_id, bot_id, user_id, message_id, event_type, rule_code,
        action, masked_excerpt, score, operator, metadata, created_at
      ) VALUES ($1, $2, 'fixture-bot', $3, 'fixture-message', $4, $5, $6,
        'masked fixture', 0.75, 'ADMIN', $7::jsonb, $8::timestamp)
      ${replay ? 'ON CONFLICT (id) DO NOTHING' : ''}`,
      [
        event.id,
        event.chat ?? 'fixture-chat',
        event.user ?? 'fixture-user',
        event.eventType ?? 'MESSAGE',
        event.rule ?? 'TEST',
        event.action ?? 'WARN',
        event.metadata === undefined ? null : JSON.stringify(event.metadata),
        event.at ?? '2026-09-30T12:05:00.000Z',
      ],
    );
  }

  async function paired(events: Event[], replay = false) {
    for (const event of events)
      for (const schema of [legacySchema, optimizedSchema])
        await insert(client, schema, event, replay);
  }

  async function snapshot(schema: string, omitTime = false) {
    const result: Record<string, unknown[]> = {};
    for (const table of tables) {
      const rows = (await client.query(`SELECT * FROM "${schema}"."${table}"`)).rows;
      for (const row of rows) {
        if (row.affected_user_ids) row.affected_user_ids = [...row.affected_user_ids].sort();
        if (omitTime) delete row.updated_at;
      }
      result[table] = rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    return result;
  }

  async function hoursIdentity(schema: string) {
    return (
      await client.query(`SELECT xmin::text, ctid::text, updated_at
      FROM "${schema}".chat_moderation_affected_user_hours ORDER BY user_id`)
    ).rows;
  }

  async function seedArray(schema: string, arrayLiteral: string) {
    await client.query(
      `INSERT INTO "${schema}".chat_moderation_stats_rollups
      (chat_id, bucket_start, affected_user_ids)
      VALUES ('fixture-chat', '2026-09-30T12:00:00', $1::text[])`,
      [arrayLiteral],
    );
  }

  it('preserves all action counters, manual NONE mapping, feeds, metadata and time buckets', async () => {
    await client.query('BEGIN');
    await paired([
      { id: 'warn', metadata: { targetDisplayName: '  Target  ' } },
      {
        id: 'delete',
        action: 'DELETE_MESSAGE',
        user: 'second',
        metadata: { userDisplayName: 'Second' },
      },
      {
        id: 'mute',
        action: 'MUTE',
        user: '  retained spaces  ',
        metadata: { senderName: 'Sender' },
      },
      { id: 'kick', action: 'KICK', user: '' },
      { id: 'ban', action: 'BAN', user: '   ' },
      { id: 'unmute', action: 'NONE', rule: 'MANUAL_UNMUTE', eventType: 'MEMBER_ACTION' },
      { id: 'unban', action: 'NONE', rule: 'MANUAL_UNBAN', eventType: 'SYSTEM' },
      { id: 'ignored', action: 'NONE', rule: 'OTHER' },
      { id: 'late', action: 'BAN', at: '2026-08-01T23:59:59.999Z' },
      { id: 'boundary', at: '2026-09-30T13:00:00.000Z', chat: 'other-chat' },
    ]);
    expect(await snapshot(optimizedSchema)).toEqual(await snapshot(legacySchema));
    const counts = (
      await client.query(`SELECT warn, delete_message, mute, ban, unmute, unban
      FROM "${optimizedSchema}".chat_moderation_stats_rollups
      WHERE chat_id='fixture-chat' AND bucket_start='2026-09-30T12:00:00'`)
    ).rows[0];
    expect(counts).toEqual({ warn: 1, delete_message: 1, mute: 1, ban: 2, unmute: 1, unban: 1 });
    const feed = (
      await client.query(`SELECT user_display_name, operator, score, metadata
      FROM "${optimizedSchema}".chat_moderation_feed_items WHERE id='warn'`)
    ).rows[0];
    expect(feed).toEqual({
      user_display_name: 'Target',
      operator: 'ADMIN',
      score: 0.75,
      metadata: { targetDisplayName: '  Target  ' },
    });
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS n FROM "${optimizedSchema}".chat_moderation_feed_items`,
        )
      ).rows[0].n,
    ).toBe(9);
    await client.query('COMMIT');
  });

  it('skips physically identical hour timestamps while preserving counters and feed inserts', async () => {
    await client.query('BEGIN');
    await paired([{ id: 'first' }]);
    const before = await hoursIdentity(optimizedSchema);
    const oldBefore = await hoursIdentity(legacySchema);
    await paired(Array.from({ length: 100 }, (_, n) => ({ id: `repeat-${n}` })));
    expect(await hoursIdentity(optimizedSchema)).toEqual(before);
    expect(await hoursIdentity(legacySchema)).not.toEqual(oldBefore);
    expect(await snapshot(optimizedSchema)).toEqual(await snapshot(legacySchema));
    expect(
      (await client.query(`SELECT warn FROM "${optimizedSchema}".chat_moderation_stats_rollups`))
        .rows[0].warn,
    ).toBe(101);
    await client.query('COMMIT');
  });

  it('still advances hour freshness in a later transaction, including an old transaction timestamp', async () => {
    await client.query('BEGIN');
    await paired([{ id: 'before' }]);
    await client.query('COMMIT');
    for (const schema of [legacySchema, optimizedSchema])
      await client.query(
        `UPDATE "${schema}".chat_moderation_affected_user_hours SET updated_at='2099-01-01'`,
      );
    await client.query('BEGIN');
    const at = (await client.query('SELECT CURRENT_TIMESTAMP::timestamp(3) AS at')).rows[0].at;
    await paired([{ id: 'after' }]);
    expect((await hoursIdentity(optimizedSchema))[0].updated_at).toEqual(at);
    expect(await snapshot(optimizedSchema)).toEqual(await snapshot(legacySchema));
    await client.query('COMMIT');
  });

  it.each([
    '{}',
    '{fixture-user}',
    '{fixture-user,fixture-user}',
    '{"",fixture-user,"   ",NULL}',
    '{other,fixture-user}',
    '[2:2]={fixture-user}',
    '{{fixture-user}}',
  ])('preserves exact legacy cleanup for array %s', async (arrayLiteral) => {
    await client.query('BEGIN');
    for (const schema of [legacySchema, optimizedSchema]) await seedArray(schema, arrayLiteral);
    await paired([{ id: 'member' }]);
    expect(await snapshot(optimizedSchema)).toEqual(await snapshot(legacySchema));
    const dimensions = await Promise.all(
      [legacySchema, optimizedSchema].map(
        async (schema) =>
          (
            await client.query(`SELECT array_dims(affected_user_ids) AS dims
        FROM "${schema}".chat_moderation_stats_rollups`)
          ).rows[0].dims,
      ),
    );
    expect(dimensions[1]).toEqual(dimensions[0]);
    await client.query('COMMIT');
  });

  it('retains cleanup for large noncanonical legacy arrays without a membership shortcut', async () => {
    await client.query('BEGIN');
    for (const schema of [legacySchema, optimizedSchema])
      await client.query(`INSERT INTO "${schema}".chat_moderation_stats_rollups
        (chat_id, bucket_start, affected_user_ids) VALUES ('fixture-chat', '2026-09-30T12:00:00',
          array_fill('fixture-user'::text, ARRAY[10000]) || ARRAY['', NULL, 'other'])`);
    await paired([{ id: 'member' }]);
    expect(await snapshot(optimizedSchema)).toEqual(await snapshot(legacySchema));
    expect(
      (
        await client.query(
          `SELECT affected_user_ids FROM "${optimizedSchema}".chat_moderation_stats_rollups`,
        )
      ).rows[0].affected_user_ids.sort(),
    ).toEqual(['fixture-user', 'other']);
    await client.query('COMMIT');
  });

  it.each(['', '   '])(
    'keeps canonical empty/singleton arrays for a blank subject %s',
    async (user) => {
      for (const arrayLiteral of ['{}', '{fixture-user}']) {
        await client.query('BEGIN');
        for (const schema of [legacySchema, optimizedSchema]) await seedArray(schema, arrayLiteral);
        await paired([{ id: 'blank', user }]);
        expect(await snapshot(optimizedSchema)).toEqual(await snapshot(legacySchema));
        await client.query('ROLLBACK');
      }
    },
  );

  it('preserves the legacy error and rollback for incompatible multidimensional arrays', async () => {
    for (const schema of [legacySchema, optimizedSchema]) {
      await client.query('BEGIN');
      await seedArray(schema, '{{fixture-user,other}}');
      await expect(insert(client, schema, { id: 'bad-shape' })).rejects.toMatchObject({
        code: '2202E',
      });
      await client.query('ROLLBACK');
      expect(await snapshot(schema)).toEqual(await snapshot(optimizedSchema));
    }
  });

  it('uses the legacy cleanup for physically large singleton TOAST values', async () => {
    const user = randomBytes(32768).toString('base64');
    for (const schema of [legacySchema, optimizedSchema])
      await client.query(`ALTER TABLE "${schema}".chat_moderation_stats_rollups
        ALTER COLUMN affected_user_ids SET STORAGE EXTERNAL`);
    async function chunks(schema: string) {
      const toast = (
        await client.query(
          'SELECT reltoastrelid::regclass::text AS name FROM pg_class WHERE oid=$1::regclass',
          [`${schema}.chat_moderation_stats_rollups`],
        )
      ).rows[0].name;
      return (
        await client.query(`SELECT chunk_id, chunk_seq FROM ${toast} ORDER BY chunk_id, chunk_seq`)
      ).rows;
    }
    await client.query('BEGIN');
    // A legacy array may contain a large value; source/user indexes correctly
    // disallow that value as a new subject, so retain it beside a blank subject.
    for (const schema of [legacySchema, optimizedSchema]) await seedArray(schema, `{${user}}`);
    expect(
      (
        await client.query(`SELECT pg_column_size(affected_user_ids) AS bytes
        FROM "${optimizedSchema}".chat_moderation_stats_rollups`)
      ).rows[0].bytes,
    ).toBeGreaterThan(128);
    await paired([{ id: 'first', user: '' }]);
    const oldBefore = await chunks(legacySchema);
    const before = await chunks(optimizedSchema);
    expect(before.length).toBeGreaterThan(10);
    await paired(Array.from({ length: 10 }, (_, n) => ({ id: `same-${n}`, user: '' })));
    expect(await chunks(optimizedSchema)).not.toEqual(before);
    expect(await chunks(legacySchema)).not.toEqual(oldBefore);
    expect(await snapshot(optimizedSchema)).toEqual(await snapshot(legacySchema));
    await client.query('COMMIT');
  });

  it('does not increment on an exact source replay or change existing UPDATE trigger semantics', async () => {
    await client.query('BEGIN');
    await paired([{ id: 'same' }]);
    const before = await snapshot(optimizedSchema);
    const identity = await hoursIdentity(optimizedSchema);
    await paired([{ id: 'same' }], true);
    expect(await snapshot(optimizedSchema)).toEqual(before);
    expect(await hoursIdentity(optimizedSchema)).toEqual(identity);
    for (const schema of [legacySchema, optimizedSchema])
      await client.query(`UPDATE "${schema}".moderation_events SET action='BAN' WHERE id='same'`);
    expect(await snapshot(optimizedSchema)).toEqual(await snapshot(legacySchema));
    expect(
      (
        await client.query(
          `SELECT warn, ban FROM "${optimizedSchema}".chat_moderation_stats_rollups`,
        )
      ).rows[0],
    ).toEqual({ warn: 1, ban: 0 });
    await client.query('COMMIT');
  });

  it('rolls back every counter, legacy array, hour and feed mutation atomically', async () => {
    const before = await snapshot(optimizedSchema);
    await client.query('BEGIN');
    await paired([
      { id: 'rolled', action: 'BAN' },
      { id: 'rolled-second', user: 'second' },
    ]);
    await client.query('ROLLBACK');
    expect(await snapshot(optimizedSchema)).toEqual(before);
    expect(await snapshot(legacySchema)).toEqual(before);
  });

  it('remains compatible when the original function is restored after optimized writes', async () => {
    await client.query('BEGIN');
    await paired([{ id: 'before-rollback' }, { id: 'before-rollback-repeat' }]);
    await client.query(`SET LOCAL search_path TO "${optimizedSchema}", public`);
    await client.query(originalFunction);
    await paired([
      { id: 'after-rollback', user: 'second', action: 'BAN' },
      { id: 'after-rollback-repeat' },
      { id: 'after-rollback-empty', user: '' },
    ]);
    expect(await snapshot(optimizedSchema)).toEqual(await snapshot(legacySchema));
    await client.query('COMMIT');
  });

  it.each(['fixture-user', 'new-user'])(
    'serializes concurrent inserts for %s without lost users or counters',
    async (secondUser) => {
      for (const schema of [legacySchema, optimizedSchema]) {
        const first = await connect(schema);
        const second = await connect(schema);
        try {
          await first.query('BEGIN');
          await insert(first, schema, { id: 'race-first' });
          await second.query('BEGIN');
          const pid = Number((await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
          const pending = insert(second, schema, { id: 'race-second', user: secondUser });
          let blocked = false;
          for (let n = 0; n < 50 && !blocked; n++) {
            blocked = (
              await client.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid])
            ).rows[0].blocked;
            if (!blocked) await new Promise((done) => setTimeout(done, 10));
          }
          await first.query('COMMIT');
          await pending;
          await second.query('COMMIT');
          expect(blocked).toBe(true);
        } finally {
          await first.query('ROLLBACK');
          await second.query('ROLLBACK');
          await first.end();
          await second.end();
        }
      }
      expect(await snapshot(optimizedSchema, true)).toEqual(await snapshot(legacySchema, true));
      const row = (
        await client.query(
          `SELECT warn, affected_user_ids FROM "${optimizedSchema}".chat_moderation_stats_rollups`,
        )
      ).rows[0];
      expect(row.warn).toBe(2);
      expect(row.affected_user_ids.sort()).toEqual(
        [...new Set(['fixture-user', secondUser])].sort(),
      );
      expect(
        (
          await client.query(
            `SELECT count(*)::int AS n FROM "${optimizedSchema}".chat_moderation_feed_items`,
          )
        ).rows[0].n,
      ).toBe(2);
    },
  );
});
