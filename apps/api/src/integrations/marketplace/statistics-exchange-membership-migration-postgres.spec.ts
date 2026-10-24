import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';

const databaseUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim() ?? '';
const postgres = databaseUrl ? describe : describe.skip;
const migrationRoot = resolve(__dirname, '../../../prisma/migrations');
const membershipPrefix = readFileSync(
  resolve(migrationRoot, '20261023050000_bounded_statistics_exchange_v3/migration.sql'),
  'utf8',
).split('ALTER TABLE statistics_exchange_grants')[0]!;
const alignment = readFileSync(
  resolve(migrationRoot, '20261023070000_align_statistics_exchange_membership_names/migration.sql'),
  'utf8',
);
const names = {
  foreignKey: 'statistics_exchange_membership_snapshot_entity_snapshot_fk',
  entityUnique: 'statistics_exchange_membership_snapshot_entity_identity_key',
  actorUnique: 'statistics_exchange_membership_snapshot_actor_request_key',
};
const oldNames = {
  foreignKey: 'statistics_exchange_membership_snapshot_entiti_snapshot_id_fkey',
  entityUnique: 'statistics_exchange_membership_s_snapshot_id_kind_entity_id_key',
  actorUnique: 'statistics_exchange_membership_sna_actor_user_id_request_id_key',
};

postgres('statistics exchange membership metadata upgrade on PostgreSQL', () => {
  let client: Client;
  let schema: string;
  let snapshotId: string;
  let requestId: string;

  beforeEach(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable race_test database required');
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    schema = `exchange_upgrade_${randomUUID().replaceAll('-', '')}`;
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(membershipPrefix);
    snapshotId = randomUUID();
    requestId = randomUUID();
    await client.query(
      `INSERT INTO statistics_exchange_membership_snapshots
       (id,actor_user_id,request_id,membership_revision,sha256,entity_count,page_count,expires_at)
       VALUES ($1,'123',$2,7,$3,1,1,now()+interval '5 minutes')`,
      [snapshotId, requestId, 'a'.repeat(64)],
    );
    await client.query(
      `INSERT INTO statistics_exchange_membership_snapshot_entities
       (snapshot_id,ordinal,entity_id,kind,profile) VALUES ($1,0,'-123','CHANNEL','moderation')`,
      [snapshotId],
    );
  });

  afterEach(async () => {
    try {
      if (schema) {
        await client.query('ROLLBACK');
        await client.query('RESET search_path');
        await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
    } finally {
      await client?.end();
    }
  });

  async function constraints() {
    const result = await client.query<{ oid: number; conname: string; conindid: number }>(
      'SELECT oid::int,conname,conindid::int FROM pg_constraint WHERE connamespace=$1::regnamespace',
      [schema],
    );
    return new Map(result.rows.map((row) => [row.conname, row]));
  }

  async function retainedRows() {
    return (
      await client.query(
        `SELECT snapshot_id::text,ordinal,entity_id,kind,profile,xmin::text
         FROM statistics_exchange_membership_snapshot_entities ORDER BY ordinal`,
      )
    ).rows;
  }

  it('preserves populated rows, indexes and constraint identities while keeping unique and cascade semantics', async () => {
    const before = await constraints();
    const rows = await retainedRows();
    await client.query(alignment);
    const after = await constraints();
    for (const key of ['foreignKey', 'entityUnique', 'actorUnique'] as const) {
      expect(before.get(oldNames[key])).toBeDefined();
      expect(after.get(names[key])).toEqual({ ...before.get(oldNames[key]), conname: names[key] });
      expect(after.has(oldNames[key])).toBe(false);
    }
    expect(await retainedRows()).toEqual(rows);
    await expect(
      client.query(
        `INSERT INTO statistics_exchange_membership_snapshot_entities
         (snapshot_id,ordinal,entity_id,kind,profile) VALUES ($1,1,'-123','CHANNEL','publisher')`,
        [snapshotId],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: names.entityUnique });
    await expect(
      client.query(
        `INSERT INTO statistics_exchange_membership_snapshots
         (id,actor_user_id,request_id,membership_revision,sha256,entity_count,page_count,expires_at)
         VALUES ($1,'123',$2,7,$3,1,1,now()+interval '5 minutes')`,
        [randomUUID(), requestId, 'b'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: names.actorUnique });
    await expect(
      client.query(
        `INSERT INTO statistics_exchange_membership_snapshot_entities
         (snapshot_id,ordinal,entity_id,kind,profile) VALUES ($1,0,'-456','CHANNEL','moderation')`,
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23503', constraint: names.foreignKey });
    await client.query('DELETE FROM statistics_exchange_membership_snapshots WHERE id=$1', [
      snapshotId,
    ]);
    expect(await retainedRows()).toEqual([]);
  });

  it('rolls every earlier rename back if an expected later constraint is absent', async () => {
    await client.query(
      `ALTER TABLE statistics_exchange_membership_snapshots
       RENAME CONSTRAINT ${oldNames.actorUnique} TO unexpectedly_changed_actor_key`,
    );
    const before = await constraints();
    const rows = await retainedRows();
    await expect(client.query(alignment)).rejects.toMatchObject({ code: '42704' });
    await client.query('ROLLBACK');
    expect(await constraints()).toEqual(before);
    expect(await retainedRows()).toEqual(rows);
  });
});
