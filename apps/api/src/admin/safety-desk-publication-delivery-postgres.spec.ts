import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { Prisma } from '../prisma/prisma-client';
import { buildPublicationDeliveryCohortQuery } from './safety-desk-publication-delivery-cohort.query';
import {
  projectPublicationDeliveryCohort,
  type PublicationDeliveryCohortRow,
} from './safety-desk-publication-delivery-cohort.service';
import {
  buildPublicationDeliveryIndexesQuery,
  buildPublicationDeliveryEvidenceQuery,
  buildPublicationDeliveryLedgerQuery,
} from './safety-desk-publication-delivery-evidence.query';
import {
  projectPublicationDeliveryEvidence,
  publicationDeliveryEvidenceKeys,
  type PublicationDeliveryEvidenceRow,
  type PublicationDeliveryLedgerRow,
} from './safety-desk-publication-delivery-evidence.model';
const url = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const integration = url ? describe : describe.skip;
function nodes(value: unknown): Record<string, unknown>[] {
  return value && typeof value === 'object'
    ? [
        ...('Node Type' in value ? [value as Record<string, unknown>] : []),
        ...Object.values(value).flatMap(nodes),
      ]
    : [];
}
integration('Bounded Publisher delivery evidence on native PostgreSQL', () => {
  let pool: Pool, client: PoolClient, schema: string;
  jest.setTimeout(60000);
  beforeAll(() => {
    const parsed = new URL(url);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
      !parsed.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    pool = new Pool({ connectionString: url, max: 3, statement_timeout: 10000 });
  });
  beforeEach(async () => {
    client = await pool.connect();
    schema = `delivery_evidence_${randomUUID().replaceAll('-', '')}`;
    await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}, public; SET TIME ZONE 'UTC';
      CREATE TABLE managed_broadcast_deliveries (LIKE public.managed_broadcast_deliveries INCLUDING DEFAULTS);
      ALTER TABLE managed_broadcast_deliveries ADD PRIMARY KEY(id);
      CREATE INDEX managed_broadcast_deliveries_dispatch_status_created_id_idx ON managed_broadcast_deliveries(dispatch_profile,status,created_at,id);
      CREATE TABLE managed_broadcasts (id text PRIMARY KEY,publication_occurrence_id text,dispatch_profile "PublicationDispatchProfile",required_bot_id text,created_at timestamp(3));
      CREATE TABLE publication_occurrences (id text PRIMARY KEY,publication_id text,required_bot_id text,dispatch_profile "PublicationDispatchProfile",created_at timestamp(3),scheduled_at timestamp(3),delivery_deadline_at timestamp(3),retry_authorized_at timestamp(3),retry_expires_at timestamp(3),dispatch_blocker_code text,dispatch_blocked_at timestamp(3));
      CREATE TABLE publication_content_revisions (id text PRIMARY KEY,publication_id text,created_at timestamp(3));
      CREATE TABLE max_action_ledger (LIKE public.max_action_ledger INCLUDING DEFAULTS);
      CREATE UNIQUE INDEX max_action_ledger_job_id_key ON max_action_ledger(job_id);
      INSERT INTO managed_broadcasts VALUES ('broadcast','occurrence','PUBLIK_V1','publisher',now()-interval '2 days');
      INSERT INTO publication_occurrences VALUES ('occurrence','publication','publisher','PUBLIK_V1',now()-interval '2 days',now()-interval '2 days',now()+interval '1 day',NULL,NULL,NULL,NULL);
      INSERT INTO publication_content_revisions VALUES ('content','publication',now()-interval '2 days');`);
  });
  afterEach(async () => {
    if (client) {
      await client.query(
        `ROLLBACK; SET statement_timeout='10000ms';DROP SCHEMA ${schema} CASCADE;RESET search_path;RESET lock_timeout`,
      );
      client.release();
    }
  });
  afterAll(async () => pool?.end());
  async function query<T>(sql: Prisma.Sql): Promise<T[]> {
    return (await client.query(sql.text, sql.values)).rows;
  }
  async function insert(id: string, status = 'PENDING') {
    await client.query(
      `INSERT INTO managed_broadcast_deliveries(id,broadcast_id,occurrence_index,target_chat_id,dispatch_profile,required_bot_id,publication_occurrence_id,content_revision_id,status,created_at,updated_at)
      VALUES($1,'broadcast',1,'private-chat','PUBLIK_V1','publisher','occurrence','content',$2,now()-interval '60 seconds',now())`,
      [id, status],
    );
  }
  async function snapshot() {
    return projectPublicationDeliveryCohort(
      await query<PublicationDeliveryCohortRow>(buildPublicationDeliveryCohortQuery(schema)),
    );
  }
  it('includes six stored statuses and legacy-derived unknown after bounded selection', async () => {
    for (const status of ['PENDING', 'SENDING', 'SENT', 'FAILED', 'AMBIGUOUS', 'CANCELED'])
      await insert(status, status);
    await client.query(`UPDATE managed_broadcast_deliveries SET remote_message_id='remote',bot_id='publisher',sent_at=created_at+interval '1 second',remote_message_verification_attempt_count=3,remote_message_verification_absent_count=3,remote_message_verification_attempted_at=created_at+interval '2 seconds',remote_message_verification_last_error='MAX exact message lookup confirmed that the message is absent',last_error='MAX несколько раз подтвердил, что сообщение исчезло после отправки. Проверьте публикацию вручную.' WHERE id='FAILED';
      UPDATE managed_broadcast_deliveries SET legacy_sent_without_remote_id=true WHERE id='SENT';`);
    expect(await query(buildPublicationDeliveryIndexesQuery(true, schema))).toEqual([
      { ready: true },
    ]);
    const result = await snapshot();
    expect(result.totalCountLowerBound).toBe(6);
    expect(result.rows.find((row) => row.status === 'FAILED')).toMatchObject({
      effectiveStatusCounts: { AMBIGUOUS: 1 },
      receiptEvidenceCounts: { saved: 1 },
    });
    expect(result.rows.find((row) => row.status === 'SENT')).toMatchObject({
      receiptEvidenceCounts: { legacy_unproven: 1 },
    });
    expect(JSON.stringify(result)).not.toContain('private-chat');
  });

  it('preserves all six capped denominators across a 10000-recipient audience and excludes outside windows', async () => {
    await client.query(`INSERT INTO managed_broadcast_deliveries(id,broadcast_id,occurrence_index,target_chat_id,dispatch_profile,required_bot_id,publication_occurrence_id,content_revision_id,status,created_at,updated_at)
      SELECT 'all-'||n,'broadcast',1,'private-'||n,'PUBLIK_V1','publisher','occurrence','content',
        (ARRAY['PENDING','SENDING','SENT','FAILED','AMBIGUOUS','CANCELED']::"ManagedBroadcastDeliveryStatus"[])[1+(n%6)],now()-interval '60 seconds',now() FROM generate_series(1,10000) n;`);
    await insert('too-new');
    await insert('too-old');
    await insert('legacy');
    await client.query(`UPDATE managed_broadcast_deliveries SET created_at=now()-interval '5 seconds' WHERE id='too-new';
      UPDATE managed_broadcast_deliveries SET created_at=now()-interval '16 minutes' WHERE id='too-old';
      UPDATE managed_broadcast_deliveries SET dispatch_profile='LEGACY_ROUTED' WHERE id='legacy';`);
    const result = await snapshot();
    expect(result).toMatchObject({ sampleComplete: false, totalCountLowerBound: 3072 });
    expect(result.rows.every((row) => row.truncated && row.countLowerBound === 512)).toBe(true);
    expect(JSON.stringify(result.examples)).not.toMatch(/too-new|too-old|legacy/);
  });
  it('caps a 50000-recipient audience and 100000 retained rows with bounded index/PK work', async () => {
    await client.query(`INSERT INTO managed_broadcast_deliveries(id,broadcast_id,occurrence_index,target_chat_id,dispatch_profile,required_bot_id,publication_occurrence_id,content_revision_id,status,created_at,updated_at)
      SELECT 'history-'||n,'broadcast',1,'private-'||n,'PUBLIK_V1','publisher','occurrence','content','PENDING',now()-interval '30 days',now() FROM generate_series(1,100000) n;
      INSERT INTO managed_broadcast_deliveries(id,broadcast_id,occurrence_index,target_chat_id,dispatch_profile,required_bot_id,publication_occurrence_id,content_revision_id,status,created_at,updated_at)
      SELECT 'fresh-'||lpad(n::text,6,'0'),'broadcast',1,'private-'||n,'PUBLIK_V1','publisher','occurrence','content','PENDING',now()-interval '60 seconds',now() FROM generate_series(1,50000) n;
      ANALYZE managed_broadcast_deliveries; ANALYZE managed_broadcasts; ANALYZE publication_occurrences; ANALYZE publication_content_revisions; SET statement_timeout='2000ms';`);
    const result = await snapshot();
    expect(result).toMatchObject({
      sampleComplete: false,
      totalCountLowerBound: 512,
      ledgerEvidence: 'not_joined',
    });
    expect(result.examples).toHaveLength(8);
    const sql = buildPublicationDeliveryCohortQuery(schema);
    const plan = (
      await client.query(`EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) ${sql.text}`, sql.values)
    ).rows[0]['QUERY PLAN'];
    const scans = nodes(plan).filter(
      (node) => node['Relation Name'] === 'managed_broadcast_deliveries',
    );
    expect(
      scans.some(
        (node) =>
          node['Index Name'] === 'managed_broadcast_deliveries_dispatch_status_created_id_idx',
      ),
    ).toBe(true);
    expect(scans.every((node) => String(node['Node Type']).includes('Index'))).toBe(true);
    expect(
      scans.every(
        (node) => Number(node['Actual Rows']) <= 513 && Number(node['Actual Loops']) <= 512,
      ),
    ).toBe(true);
    const parents = nodes(plan).filter((node) =>
      ['managed_broadcasts', 'publication_occurrences', 'publication_content_revisions'].includes(
        String(node['Relation Name']),
      ),
    );
    expect(
      parents.every(
        (node) => Number(node['Actual Loops']) === 1 && Number(node['Actual Rows']) <= 1,
      ),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-');
  });
  it('probes distinct saved parents and at most two exact action keys across retained history', async () => {
    await client.query(`INSERT INTO managed_broadcasts
      SELECT 'parent-broadcast-'||n,'parent-occurrence-'||n,'PUBLIK_V1','publisher',now()-interval '2 days'
      FROM generate_series(1,100064) n;
      INSERT INTO publication_occurrences
      SELECT 'parent-occurrence-'||n,'parent-publication-'||n,'publisher','PUBLIK_V1',now()-interval '2 days',now()-interval '2 days',now()+interval '1 day',NULL,NULL,NULL,NULL
      FROM generate_series(1,100064) n;
      INSERT INTO publication_content_revisions
      SELECT 'parent-content-'||n,'parent-publication-'||n,now()-interval '2 days'
      FROM generate_series(1,100064) n;
      INSERT INTO managed_broadcast_deliveries(id,broadcast_id,occurrence_index,target_chat_id,dispatch_profile,required_bot_id,publication_occurrence_id,content_revision_id,status,attempt_count,created_at,updated_at)
      SELECT 'retained-delivery-'||lpad(n::text,6,'0'),'parent-broadcast-'||(1+n%64),1,'private-'||n,'PUBLIK_V1','publisher','parent-occurrence-'||(1+n%64),'parent-content-'||(1+n%64),'PENDING',2,now()-interval '60 seconds',now()
      FROM generate_series(1,512) n;
      INSERT INTO max_action_ledger(id,job_id,action_type,chat_id,source_tag,created_at,updated_at)
      SELECT 'retained-ledger-'||n,'unrelated-key-'||n,'SEND_MESSAGE','private-1','managed_broadcast',now()-interval '30 days',now()
      FROM generate_series(1,100000) n;
      ANALYZE managed_broadcast_deliveries; ANALYZE managed_broadcasts; ANALYZE publication_occurrences; ANALYZE publication_content_revisions; ANALYZE max_action_ledger;
      SET statement_timeout='2000ms';`);
    const parentTables = [
      'managed_broadcasts',
      'publication_occurrences',
      'publication_content_revisions',
    ];
    const explain = async (sql: Prisma.Sql) =>
      nodes(
        (
          await client.query(
            `EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) ${sql.text}`,
            sql.values,
          )
        ).rows[0]['QUERY PLAN'],
      );
    const cohort = buildPublicationDeliveryCohortQuery(schema);
    const rows = await query<PublicationDeliveryCohortRow>(cohort);
    expect(projectPublicationDeliveryCohort(rows)).toMatchObject({
      totalCountLowerBound: 512,
      sampleComplete: true,
    });
    expect(new Set(rows.filter((row) => row.id).map((row) => row.parentBroadcastId)).size).toBe(64);
    const cohortPlan = await explain(cohort);
    for (const table of parentTables) {
      const scans = cohortPlan.filter((node) => node['Relation Name'] === table);
      expect(scans).toHaveLength(1);
      expect(scans[0]).toMatchObject({
        'Index Name': `${table}_pkey`,
        'Actual Rows': 1,
        'Actual Loops': 64,
      });
      expect(String(scans[0]!['Node Type'])).toContain('Index');
      expect(
        Number(scans[0]!['Shared Hit Blocks']) + Number(scans[0]!['Shared Read Blocks']),
      ).toBeLessThanOrEqual(64 * 8);
    }
    const evidence = buildPublicationDeliveryEvidenceQuery('retained-delivery-000001', schema);
    const [row] = await query<PublicationDeliveryEvidenceRow>(evidence);
    const keys = publicationDeliveryEvidenceKeys(row!);
    expect(keys).not.toBeNull();
    const exactKeys = [keys!.currentKey, keys!.legacyKey];
    expect(new Set(exactKeys).size).toBe(2);
    await client.query(
      `INSERT INTO max_action_ledger(id,job_id,action_type,chat_id,source_tag,created_at,updated_at)
      VALUES('current-ledger',$1,'SEND_MESSAGE','private-1','managed_broadcast',now(),now()),
        ('legacy-ledger',$2,'SEND_MESSAGE','private-1','managed_broadcast',now(),now())`,
      exactKeys,
    );
    const evidencePlan = await explain(evidence);
    for (const table of ['managed_broadcast_deliveries', ...parentTables]) {
      const scans = evidencePlan.filter((node) => node['Relation Name'] === table);
      expect(scans).toHaveLength(1);
      expect(scans[0]).toMatchObject({
        'Index Name': `${table}_pkey`,
        'Actual Rows': 1,
        'Actual Loops': 1,
      });
      expect(String(scans[0]!['Node Type'])).toContain('Index');
    }
    const ledgerSql = buildPublicationDeliveryLedgerQuery(exactKeys, schema);
    const ledgers = await query<PublicationDeliveryLedgerRow>(ledgerSql);
    expect(ledgers.map((ledger) => ledger.jobId).sort()).toEqual([...exactKeys].sort());
    const ledgerPlan = await explain(ledgerSql);
    expect(ledgerPlan.some((node) => node['Index Name'] === 'max_action_ledger_job_id_key')).toBe(
      true,
    );
    const ledgerScans = ledgerPlan.filter((node) => node['Relation Name'] === 'max_action_ledger');
    expect(ledgerScans).toHaveLength(1);
    expect(String(ledgerScans[0]!['Node Type'])).not.toContain('Seq');
    expect(ledgerScans[0]).toMatchObject({ 'Actual Rows': 2, 'Actual Loops': 1 });
    expect(
      Number(ledgerScans[0]!['Shared Hit Blocks']) + Number(ledgerScans[0]!['Shared Read Blocks']),
    ).toBeLessThanOrEqual(32);
    expect(Number(ledgerScans[0]!['Rows Removed by Filter'] ?? 0)).toBe(0);
  });
  it.each(['DESC', 'NULLS FIRST', 'INCLUDE', 'PARTIAL', 'BRIN', 'WRONG_ORDER'] as const)(
    'rejects %s index before any cohort fallback',
    async (variant) => {
      await client.query('DROP INDEX managed_broadcast_deliveries_dispatch_status_created_id_idx');
      const columns =
        variant === 'WRONG_ORDER'
          ? 'status,dispatch_profile,created_at,id'
          : `dispatch_profile,status,created_at${variant === 'DESC' ? ' DESC' : variant === 'NULLS FIRST' ? ' NULLS FIRST' : ''},id`;
      if (variant === 'BRIN')
        await client.query(
          'CREATE INDEX managed_broadcast_deliveries_dispatch_status_created_id_idx ON managed_broadcast_deliveries USING brin(created_at)',
        );
      else
        await client.query(
          `CREATE INDEX managed_broadcast_deliveries_dispatch_status_created_id_idx ON managed_broadcast_deliveries(${columns})${variant === 'INCLUDE' ? ' INCLUDE(bot_id)' : variant === 'PARTIAL' ? " WHERE status='PENDING'" : ''}`,
        );
      expect(await query(buildPublicationDeliveryIndexesQuery(true, schema))).toEqual([
        { ready: false },
      ]);
    },
  );
  it('joins only exact immutable action identity and preserves recipient disagreement', async () => {
    await insert('delivery', 'SENT');
    await client.query(
      `UPDATE managed_broadcast_deliveries SET bot_id='publisher',remote_message_id='recipient-remote',attempt_count=2,sent_at=created_at+interval '20 seconds' WHERE id='delivery'`,
    );
    const row = (
      await query<PublicationDeliveryEvidenceRow>(
        buildPublicationDeliveryEvidenceQuery('delivery', schema),
      )
    )[0]!;
    const key = publicationDeliveryEvidenceKeys(row)!;
    await client.query(
      `INSERT INTO max_action_ledger(id,job_id,action_type,chat_id,source_tag,bot_id,dispatch_bot_id,status,terminal,ambiguous,created_at,updated_at,dispatch_started_at,completed_at,remote_message_id,metadata)
      VALUES('ledger',$1,'SEND_MESSAGE','private-chat','managed_broadcast','publisher','publisher','SUCCEEDED',true,false,$2,$2,$2::timestamp+interval '10 seconds',$2::timestamp+interval '20 seconds','different-remote','{"routing":{"requiredBotId":"publisher"},"secret":"not-exported"}')`,
      [key.currentKey, row.createdAt],
    );
    expect(await query(buildPublicationDeliveryIndexesQuery(false, schema))).toEqual([
      { ready: true },
    ]);
    const ledgers = await query<PublicationDeliveryLedgerRow>(
      buildPublicationDeliveryLedgerQuery([key.currentKey, key.legacyKey], schema),
    );
    expect(projectPublicationDeliveryEvidence(row, ledgers)).toMatchObject({
      action: { keyBasis: 'current', state: 'unknown' },
      recipient: { state: 'saved', agreesWithAction: false },
      automaticRetryAllowed: false,
    });
    expect(JSON.stringify(ledgers)).not.toContain('not-exported');
  });

  it('cannot bind an oversized saved broadcast identity to an empty-ID parent', async () => {
    await insert('invalid-broadcast', 'SENT');
    await client.query(`INSERT INTO managed_broadcasts SELECT '',publication_occurrence_id,dispatch_profile,required_bot_id,created_at FROM managed_broadcasts WHERE id='broadcast';
      UPDATE managed_broadcast_deliveries SET broadcast_id=repeat('x',513),bot_id='publisher',remote_message_id='remote',sent_at=created_at+interval '1 second' WHERE id='invalid-broadcast'`);
    const [row] = await query<PublicationDeliveryEvidenceRow>(
      buildPublicationDeliveryEvidenceQuery('invalid-broadcast', schema),
    );
    expect(row).toMatchObject({ broadcastId: '', parentBroadcastId: '' });
    expect(projectPublicationDeliveryEvidence(row!, [])).toMatchObject({
      binding: 'invalid_evidence',
      recipient: { state: 'invalid_evidence' },
      automaticRetryAllowed: false,
    });
    expect(publicationDeliveryEvidenceKeys(row!)).toBeNull();
  });

  it.each(['INHERITANCE_PARENT', 'INHERITANCE_CHILD', 'DEFERRABLE'] as const)(
    'rejects %s parent lookup indexes',
    async (variant) => {
      if (variant === 'INHERITANCE_PARENT')
        await client.query('CREATE TABLE inherited_broadcasts () INHERITS (managed_broadcasts)');
      else if (variant === 'INHERITANCE_CHILD')
        await client.query(
          'CREATE TABLE inheritance_root (LIKE managed_broadcasts); ALTER TABLE managed_broadcasts INHERIT inheritance_root',
        );
      else
        await client.query(
          'ALTER TABLE managed_broadcasts DROP CONSTRAINT managed_broadcasts_pkey; ALTER TABLE managed_broadcasts ADD PRIMARY KEY(id) DEFERRABLE',
        );
      expect(await query(buildPublicationDeliveryIndexesQuery(true, schema))).toEqual([
        { ready: false },
      ]);
      expect(await query(buildPublicationDeliveryIndexesQuery(false, schema))).toEqual([
        { ready: false },
      ]);
    },
  );

  it.each(['OPCLASS', 'COLLATION', 'UNLOGGED', 'STORAGE'] as const)(
    'rejects nondefault %s index properties',
    async (variant) => {
      await client.query('DROP INDEX managed_broadcast_deliveries_dispatch_status_created_id_idx');
      if (variant === 'UNLOGGED')
        await client.query('ALTER TABLE managed_broadcast_deliveries SET UNLOGGED');
      await client.query(
        `CREATE INDEX managed_broadcast_deliveries_dispatch_status_created_id_idx ON managed_broadcast_deliveries(dispatch_profile,status,created_at,id${variant === 'OPCLASS' ? ' text_pattern_ops' : variant === 'COLLATION' ? ' COLLATE "C"' : ''})${variant === 'STORAGE' ? ' WITH(fillfactor=80)' : ''}`,
      );
      expect(await query(buildPublicationDeliveryIndexesQuery(true, schema))).toEqual([
        { ready: false },
      ]);
    },
  );
  it('reads a coherent snapshot without waiting for foreign row locks', async () => {
    await insert('locked', 'PENDING');
    const other = await pool.connect();
    try {
      await other.query('BEGIN');
      await other.query(
        `UPDATE ${schema}.managed_broadcast_deliveries SET status='CANCELED' WHERE id='locked'`,
      );
      await client.query(
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;SET LOCAL lock_timeout='250ms';SET LOCAL statement_timeout='2000ms'",
      );
      expect((await snapshot()).rows.find((row) => row.status === 'PENDING')?.countLowerBound).toBe(
        1,
      );
      await other.query('COMMIT');
      expect((await snapshot()).rows.find((row) => row.status === 'PENDING')?.countLowerBound).toBe(
        1,
      );
      await client.query('COMMIT');
      expect(
        (await snapshot()).rows.find((row) => row.status === 'CANCELED')?.countLowerBound,
      ).toBe(1);
    } finally {
      await other.query('ROLLBACK');
      other.release();
    }
  });
});
