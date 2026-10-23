import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const postgres = databaseUrl ? describe : describe.skip;
const migration = readFileSync(
  resolve(
    __dirname,
    '../../../prisma/migrations/20261023030000_preserve_explicit_statistics_revocation/migration.sql',
  ),
  'utf8',
);
jest.setTimeout(30_000);

postgres('explicit marketplace statistics denial during a mixed-runtime release', () => {
  let db: Client;
  let other: Client;
  let schema: string;
  beforeAll(() => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable race_test database required');
  });
  beforeEach(async () => {
    schema = 'statistics_revoke_' + randomUUID().replaceAll('-', '');
    db = new Client({ connectionString: databaseUrl, statement_timeout: 10_000 });
    other = new Client({ connectionString: databaseUrl, statement_timeout: 10_000 });
    await db.connect();
    await other.connect();
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}",public`);
    await other.query(`SET search_path TO "${schema}",public`);
    await db.query(`CREATE TABLE marketplace_bindings (
      id uuid PRIMARY KEY, state text NOT NULL DEFAULT 'ACTIVE', statistics_consent boolean NOT NULL DEFAULT false,
      statistics_v2_consent_only boolean NOT NULL DEFAULT false, append_enabled boolean NOT NULL DEFAULT false,
      append_revision integer NOT NULL DEFAULT 0, revision integer NOT NULL DEFAULT 0,
      lease_id uuid, lease_until timestamptz, public_verified_until timestamptz);
      CREATE TABLE marketplace_policy_requests (
        request_id uuid PRIMARY KEY, binding_id uuid NOT NULL REFERENCES marketplace_bindings(id),
        payload_hash text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
  });
  afterEach(async () => {
    await db.query('ROLLBACK');
    await other.query('ROLLBACK');
    await other.end();
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.end();
  });
  const binding = async (consent = false, v2Only = false, state = 'ACTIVE') => {
    const id = randomUUID();
    await db.query(
      'INSERT INTO marketplace_bindings(id,statistics_consent,statistics_v2_consent_only,state) VALUES($1,$2,$3,$4)',
      [id, consent, v2Only, state],
    );
    return id;
  };
  const receipt = async (
    id: string,
    action: 'integration' | 'revoke' | 'toggle',
    extra = false,
  ) => {
    const requestId = randomUUID();
    const result =
      action === 'integration'
        ? { revoked: true, ...(extra ? { extra: true } : {}) }
        : {
            binding: { id, state: 'REVOKED', statisticsConsent: false },
            appendEnabled: false,
            appendRevision: 1,
          };
    const payloadHash = createHash('sha256')
      .update(JSON.stringify({ bindingId: id, action, requestId, expectedRevision: 0 }))
      .digest('hex');
    await db.query(
      'INSERT INTO marketplace_policy_requests(request_id,binding_id,payload_hash,result) VALUES($1,$2,$3,$4::jsonb)',
      [requestId, id, payloadHash, JSON.stringify(result)],
    );
    return requestId;
  };
  it('backfills only proven revoke receipts, including automatic reenabling, and preserves independent legacy true', async () => {
    const plainFalse = await binding();
    const unknown = await binding(false, false, 'UNKNOWN');
    const integration = await binding();
    const profile = await binding();
    const automatic = await binding(true, true);
    const independent = await binding(true, false);
    const toggle = await binding();
    const extra = await binding();
    await receipt(integration, 'integration');
    await receipt(profile, 'revoke');
    await receipt(automatic, 'revoke');
    await receipt(independent, 'integration');
    await receipt(toggle, 'toggle');
    await receipt(extra, 'integration', true);
    await db.query(
      "UPDATE marketplace_bindings SET append_enabled=true,public_verified_until=now()+interval '5 minutes',lease_id=$1,lease_until=now()+interval '2 minutes' WHERE id=$2",
      [randomUUID(), automatic],
    );
    await db.query(migration);
    const rows = await db.query<{
      id: string;
      statistics_revoked_at: Date | null;
      statistics_consent: boolean;
      statistics_v2_consent_only: boolean;
    }>('SELECT * FROM marketplace_bindings');
    for (const id of [integration, profile, automatic]) {
      expect(rows.rows.find((row) => row.id === id)).toMatchObject({
        statistics_revoked_at: expect.any(Date),
        statistics_consent: false,
        statistics_v2_consent_only: false,
      });
    }
    for (const id of [plainFalse, unknown, independent, toggle, extra])
      expect(rows.rows.find((row) => row.id === id)!.statistics_revoked_at).toBeNull();
    expect(rows.rows.find((row) => row.id === independent)!.statistics_consent).toBe(true);
    expect(rows.rows.find((row) => row.id === automatic)).toMatchObject({
      append_enabled: false,
      public_verified_until: null,
      lease_id: null,
      lease_until: null,
      revision: 1,
      append_revision: 1,
    });
  });
  it('fences the old receipt writer and automatic SQL while allowing only the new explicit legacy policy CAS to clear', async () => {
    await db.query(migration);
    const id = await binding(true);
    await db.query(
      "UPDATE marketplace_bindings SET state='REVOKED',statistics_consent=false,append_revision=append_revision+1,revision=revision+1 WHERE id=$1",
      [id],
    );
    const requestId = await receipt(id, 'integration');
    await db.query(
      "UPDATE marketplace_bindings SET state='ACTIVE',statistics_v2_consent_only=CASE WHEN statistics_consent=false THEN true ELSE statistics_v2_consent_only END,statistics_consent=true,revision=revision+1 WHERE id=$1",
      [id],
    );
    expect(
      (await db.query('SELECT * FROM marketplace_bindings WHERE id=$1', [id])).rows[0],
    ).toMatchObject({
      statistics_consent: false,
      statistics_v2_consent_only: false,
      statistics_revoked_at: expect.any(Date),
    });
    await db.query(
      'UPDATE marketplace_bindings SET statistics_revoked_at=NULL,statistics_consent=true WHERE id=$1',
      [id],
    );
    expect(
      (await db.query('SELECT statistics_revoked_at FROM marketplace_bindings WHERE id=$1', [id]))
        .rows[0].statistics_revoked_at,
    ).toBeInstanceOf(Date);
    await db.query(
      'UPDATE marketplace_bindings SET statistics_revoked_at=NULL,statistics_consent=true,statistics_v2_consent_only=false,append_revision=append_revision+1,revision=revision+1 WHERE id=$1 AND append_revision=2',
      [id],
    );
    await db.query(
      'INSERT INTO marketplace_policy_requests SELECT * FROM marketplace_policy_requests WHERE request_id=$1 ON CONFLICT DO NOTHING',
      [requestId],
    );
    expect(
      (await db.query('SELECT * FROM marketplace_bindings WHERE id=$1', [id])).rows[0],
    ).toMatchObject({ statistics_consent: true, statistics_revoked_at: null });
  });
  it('serializes a genuine old revoke receipt with an already waiting old automatic enable', async () => {
    await db.query(migration);
    const id = await binding(true);
    await db.query('BEGIN');
    await db.query(
      "UPDATE marketplace_bindings SET state='REVOKED',statistics_consent=false,append_revision=append_revision+1,revision=revision+1 WHERE id=$1",
      [id],
    );
    await receipt(id, 'revoke');
    const ownPid = (await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const otherPid = (await other.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
      .pid;
    const enable = other.query(
      "UPDATE marketplace_bindings SET state='ACTIVE',statistics_consent=true,statistics_v2_consent_only=true,revision=revision+1 WHERE id=$1 RETURNING *",
      [id],
    );
    try {
      const deadline = Date.now() + 5_000;
      let blocked = false;
      while (Date.now() < deadline) {
        blocked = (
          await db.query<{ blocked: boolean }>(
            'SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked',
            [ownPid, otherPid],
          )
        ).rows[0]!.blocked;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await db.query('COMMIT');
      expect((await enable).rows[0]).toMatchObject({
        statistics_consent: false,
        statistics_v2_consent_only: false,
        statistics_revoked_at: expect.any(Date),
      });
    } finally {
      await db.query('ROLLBACK');
      await enable;
    }
  });
});
