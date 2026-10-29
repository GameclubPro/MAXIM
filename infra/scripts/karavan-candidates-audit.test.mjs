import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import {
  parseKaravanCandidateArgs,
  buildKaravanCandidateQuery,
  buildKaravanCandidateAuditSql,
  buildKaravanCandidatePrivilegesSql,
  buildKaravanCandidateProvisionSql,
} from './karavan-candidates-audit.mjs';

test('candidate scope is bounded, cursor exact and no duplicate/unsafe arguments accepted', () => {
  assert.deepEqual(parseKaravanCandidateArgs([]), { after: '', limit: 40, explain: false });
  assert.equal(parseKaravanCandidateArgs(['--after', 'synthetic-id', '--limit', '2']).limit, 2);
  for (const args of [
    ['--limit', '0'],
    ['--limit', '41'],
    ['--limit', '40', '--limit', '40'],
    ['--after', "x';SELECT 1"],
    ['--after', ''],
    ['--explain', '--explain'],
    ['--chat', '-1'],
  ])
    assert.throws(() => parseKaravanCandidateArgs(args));
  const sql = buildKaravanCandidateAuditSql(['--limit', '2', '--explain']);
  assert.match(sql, /EXPLAIN \(FORMAT JSON\)/u);
  assert.doesNotMatch(sql, /EXPLAIN ANALYZE/u);
  assert.match(sql, /LIMIT 3/u);
  assert.match(sql, /LIMIT 65/u);
  assert.doesNotMatch(sql, /FROM (?:public\.)?audit_logs|actor_user_id|payload/iu);
  assert.match(sql, /'ownershipEstablished',false/u);
  assert.match(sql, /'requiresAdministratorConsent',true/u);
});

test('reviewed runners use narrow projections and retain audit payload isolation', () => {
  const provision = readFileSync(
    new URL('./vps-provision-postgres-audit-role.sh', import.meta.url),
    'utf8',
  );
  assert.ok(provision.includes(buildKaravanCandidateProvisionSql()));
  assert.doesNotMatch(buildKaravanCandidateProvisionSql(), /GRANT SELECT[^;]+audit_logs/u);
  assert.match(
    buildKaravanCandidatePrivilegesSql(),
    /NOT has_table_privilege\('maxim_audit','public.audit_logs'/u,
  );
  const runner = readFileSync(new URL('./vps-postgres-audit.sh', import.meta.url), 'utf8');
  assert.match(
    runner,
    /'karavan-candidates' \]\]; then\n {2}POSTGRES_AUDIT_OPTIONS\+=' -c search_path=pg_catalog,public,pg_temp'/u,
  );
  for (const file of ['./vps-postgres-audit.sh', './vps-connect.sh'])
    assert.match(
      readFileSync(new URL(file, import.meta.url), 'utf8'),
      /karavan-candidates-audit\.mjs/u,
    );
});

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
test(
  'native candidate pages preserve provenance ambiguity, indexed bounds and least privilege',
  { skip: !databaseUrl },
  async () => {
    const url = new URL(databaseUrl);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    const db = new Client({ connectionString: databaseUrl });
    await db.connect();
    const chats = ['-981000001', '-981000002', '-981000003'];
    try {
      for (let index = 0; index < chats.length; index++) {
        await db.query(
          "INSERT INTO chats(id,title,entity_type,updated_at) VALUES($1,$2,'CHAT',now())",
          [chats[index], `Synthetic candidate ${index}`],
        );
        await db.query(
          'INSERT INTO chat_settings(id,chat_id,updated_at,karavan_storefront_enabled) VALUES($1,$2,now(),$3)',
          [`synthetic-candidate-${index}`, chats[index], index !== 2],
        );
      }
      await db.query(
        `INSERT INTO audit_logs(id,chat_id,actor_user_id,action,payload,created_at)
      SELECT 'synthetic-setting-'||n,$1,'private-user','UPDATE_SETTINGS',jsonb_build_object('settingKeys',jsonb_build_array('karavanStorefrontEnabled'),'secret','never-disclose-this-value'),now()-n*interval '1 second' FROM generate_series(1,80)n`,
        [chats[0]],
      );
      await db.query(
        'INSERT INTO audit_logs(id,chat_id,actor_user_id,action,payload) VALUES($1,$2,$3,$4,$5::jsonb)',
        [
          'synthetic-relay',
          chats[1],
          'private-user',
          'KARAVAN_STOREFRONT_RELAY',
          JSON.stringify({
            deliveryStatus: 'sent',
            companionMessageId: 'private-message',
            secret: 'never-disclose-this-value',
          }),
        ],
      );
      await db.query('CREATE ROLE maxim_audit NOLOGIN');
      await db.query('GRANT USAGE ON SCHEMA public TO maxim_audit');
      await db.query(buildKaravanCandidateProvisionSql());
      await db.query('BEGIN READ ONLY');
      await db.query('SET LOCAL ROLE maxim_audit');
      await db.query('SET LOCAL enable_seqscan=off');
      await db.query('SET LOCAL enable_bitmapscan=off');
      const privileges = await db.query(
        buildKaravanCandidatePrivilegesSql(true).split('\\gset')[0],
      );
      assert.equal(privileges.rows[0].karavan_candidate_privileges_ready, true);
      const first = (await db.query(buildKaravanCandidateQuery(['--limit', '1']))).rows[0].report;
      assert.equal(first.hasMore, true);
      assert.equal(first.candidates.length, 1);
      assert.equal(first.candidates[0].storefrontFieldTouched, true);
      assert.equal(first.candidates[0].settingsEvidenceCapped, true);
      assert.equal(first.candidates[0].ownershipEstablished, false);
      const second = (
        await db.query(buildKaravanCandidateQuery(['--after', first.nextCursor, '--limit', '2']))
      ).rows[0].report;
      assert.equal(second.hasMore, false);
      assert.equal(second.candidates.length, 1);
      assert.equal(second.candidates[0].confirmedRelayObserved, true);
      assert.equal(second.candidates[0].storefrontFieldTouched, false);
      const serialized = JSON.stringify([first, second]);
      assert.doesNotMatch(serialized, /never-disclose|private-user|private-message/u);
      const plan = JSON.stringify(
        (await db.query('EXPLAIN (FORMAT JSON) ' + buildKaravanCandidateQuery(['--limit', '1'])))
          .rows,
      );
      assert.doesNotMatch(plan, /Seq Scan/u);
      assert.match(plan, /audit_logs_chat_action_created_at_idx/u);
      assert.match(plan, /chat_settings_pkey/u);
      await db.query('ROLLBACK');
    } finally {
      await db.query('ROLLBACK').catch(() => {});
      await db.query('DROP OWNED BY maxim_audit').catch(() => {});
      await db.query('DROP ROLE IF EXISTS maxim_audit');
      await db.query('DELETE FROM audit_logs WHERE chat_id=ANY($1::text[])', [chats]);
      await db.query('DELETE FROM chats WHERE id=ANY($1::text[])', [chats]);
      await db.end();
    }
  },
);
