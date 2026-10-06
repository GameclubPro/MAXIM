import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { buildRulesCleanupAuditSql } from './rules-cleanup-audit.mjs';
import { buildPublisherCommentsAuditSql } from './publisher-comments-audit.mjs';
import {
  buildPublisherPublicationsAuditSql,
  buildPublisherPublicationPrivilegesSql,
} from './publisher-publications-audit.mjs';

const root = resolve(import.meta.dirname, '../..');
const audit = resolve(root, 'infra/scripts/vps-postgres-audit.sh');
const provision = resolve(root, 'infra/scripts/vps-provision-postgres-audit-role.sh');
const connect = resolve(root, 'infra/scripts/vps-connect.sh');
const monitor = readFileSync(resolve(root, 'infra/scripts/vps-monitor-readonly.sh'), 'utf8');
const schema = readFileSync(resolve(root, 'apps/api/prisma/schema.prisma'), 'utf8');
const nativePostgresUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim();

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-postgres-audit-'));
  const auditScript = join(directory, 'audit.sh');
  const auditLock = join(directory, 'audit.lock');
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  // FLAG: Keep the production flock semantics, but isolate each test fixture from
  // other suites/worktrees that exercise the same fixed production lock path.
  const source = readFileSync(audit, 'utf8');
  assert.ok(source.includes('AUDIT_LOCK_FILE=/tmp/maxim-postgres-audit.lock'));
  writeFileSync(
    auditScript,
    source
      .replace(/^ROOT_DIR=.*$/mu, `ROOT_DIR=${quote(root)}`)
      .replace(
        'AUDIT_LOCK_FILE=/tmp/maxim-postgres-audit.lock',
        `AUDIT_LOCK_FILE=${quote(auditLock)}`,
      ),
  );
  const bin = join(directory, 'bin');
  const dockerArgs = join(directory, 'docker.args');
  const allDockerCalls = join(directory, 'docker-calls.log');
  const cleanupArgs = join(directory, 'cleanup.args');
  const sql = join(directory, 'audit.sql');
  const auditStarted = join(directory, 'audit-started');
  const dockerPid = join(directory, 'docker.pid');
  const sleepPid = join(directory, 'sleep.pid');
  const sshArgs = join(directory, 'ssh.args');
  const ycArgs = join(directory, 'yc.args');
  const envFile = join(directory, 'missing-vps-env');
  mkdirSync(bin);

  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
set -euo pipefail
all_args="$*"
printf '%s\n' "$all_args" >>"$MOCK_ALL_DOCKER_CALLS"
if [[ "$all_args" == *pg_terminate_backend* ]]; then
  printf '%s\n' "$@" >"$MOCK_CLEANUP_ARGS"
  exit 0
fi
printf '%s\n' "$@" >"$MOCK_DOCKER_ARGS"
if [[ -n "\${MOCK_NATIVE_PSQL_BRIDGE:-}" ]]; then
  exec node -- "$MOCK_NATIVE_PSQL_BRIDGE" "$@"
fi
cat >"$MOCK_AUDIT_SQL"
: >"$MOCK_AUDIT_STARTED"
if [[ "\${MOCK_AUDIT_FAIL:-0}" == "1" ]]; then
  printf '%s\n' 'ERROR near fixture-event-0001' >&2
  exit 7
fi
printf '%s' "$$" >"$MOCK_DOCKER_PID"
sleep "\${MOCK_AUDIT_SLEEP_SEC:-0}" &
sleep_pid="$!"
printf '%s' "$sleep_pid" >"$MOCK_SLEEP_PID"
wait "$sleep_pid"
printf '%s\n' '{"mock":true}'
`,
  );
  writeFileSync(
    join(bin, 'ssh'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >"$MOCK_SSH_ARGS"
`,
  );
  writeFileSync(
    join(bin, 'yc'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >"$MOCK_YC_ARGS"
`,
  );
  chmodSync(join(bin, 'docker'), 0o755);
  chmodSync(join(bin, 'ssh'), 0o755);
  chmodSync(join(bin, 'yc'), 0o755);

  return {
    directory,
    bin,
    auditScript,
    auditLock,
    dockerArgs,
    allDockerCalls,
    cleanupArgs,
    sql,
    auditStarted,
    dockerPid,
    sleepPid,
    sshArgs,
    ycArgs,
    envFile,
  };
}

function baseEnv(data) {
  const env = {
    ...process.env,
    PATH: `${data.bin}:${process.env.PATH}`,
    MOCK_DOCKER_ARGS: data.dockerArgs,
    MOCK_ALL_DOCKER_CALLS: data.allDockerCalls,
    MOCK_CLEANUP_ARGS: data.cleanupArgs,
    MOCK_AUDIT_SQL: data.sql,
    MOCK_AUDIT_STARTED: data.auditStarted,
    MOCK_DOCKER_PID: data.dockerPid,
    MOCK_SLEEP_PID: data.sleepPid,
    MOCK_SSH_ARGS: data.sshArgs,
    MOCK_YC_ARGS: data.ycArgs,
    MAXIM_VPS_ENV_FILE: data.envFile,
    MAXIM_VPS_SSH_TARGET: 'mock-vps',
    MAXIM_YC_VM_NAME: 'mock-vm',
  };
  delete env.MAXIM_VPS_DATABASE_BREAK_GLASS;
  delete env.MAXIM_VPS_DATABASE_BREAK_GLASS_REASON;
  delete env.MAXIM_INTERNAL_LEGACY_DEFAULT_WEBHOOK_AUDIT;
  return env;
}

function writeLegacyDefaultWebhookSnapshot(data) {
  const snapshot = join(data.directory, 'legacy-default-webhook-snapshot.json');
  const timestamp = Date.parse('2026-03-30T12:00:00.000Z');
  const records = [
    { id: 'fixture-event-0001', state: 'prioritized', timestamp, priority: 5 },
    {
      id: 'fixture-event-0002',
      state: 'failed',
      timestamp: timestamp + 1,
      priority: 5,
    },
  ];
  writeFileSync(
    snapshot,
    JSON.stringify({
      version: 1,
      queue: 'moderation-default',
      libraryVersion: 'bullmq:5.77.6',
      records,
      summary: {
        paused: false,
        workerCount: 0,
        jobSchedulerCount: 0,
        counts: {
          waiting: 0,
          active: 0,
          delayed: 0,
          failed: 1,
          completed: 0,
          paused: 0,
          prioritized: 1,
          'waiting-children': 0,
        },
      },
    }),
    { mode: 0o600 },
  );
  chmodSync(snapshot, 0o600);
  return snapshot;
}

function runAudit(data, args, extraEnv = {}) {
  return spawnSync('bash', [data.auditScript, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...baseEnv(data), ...extraEnv },
  });
}

function runConnect(data, args, extraEnv = {}) {
  return spawnSync('bash', [connect, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...baseEnv(data), ...extraEnv },
  });
}

function extractDuplicateReportSql(sql) {
  const startMarker = '\\if :duplicate_audit_ready\n';
  const endMarker = '\n\\else\n';
  const start = sql.indexOf(startMarker);
  const end = sql.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return sql.slice(start + startMarker.length, end);
}

function extractDuplicateReadinessSql(sql) {
  const startMarker = 'WITH required_duplicate_indexes(';
  const endMarker = 'END AS duplicate_audit_ready';
  const start = sql.indexOf(startMarker);
  const end = sql.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return `${sql.slice(start, end + endMarker.length)};`;
}

function extractAuditColumnResetSql() {
  const source = readFileSync(provision, 'utf8');
  const revokeStart = source.indexOf('DO $revoke_audit_columns$');
  const revokeEndMarker = '$revoke_audit_columns$;';
  const revokeEnd = source.indexOf(revokeEndMarker, revokeStart) + revokeEndMarker.length;
  const grantStart = source.indexOf('GRANT SELECT (', revokeEnd);
  const grantEndMarker = 'ON TABLE public.chats TO maxim_audit;';
  const grantEnd = source.indexOf(grantEndMarker, grantStart) + grantEndMarker.length;
  assert.notEqual(revokeStart, -1);
  assert.ok(revokeEnd >= revokeEndMarker.length);
  assert.notEqual(grantStart, -1);
  assert.ok(grantEnd >= grantEndMarker.length);
  const receiptStart = source.indexOf('DO $multibot_preparation_grants$');
  const receiptEndMarker = '$multibot_preparation_grants$;';
  const receiptEnd = source.indexOf(receiptEndMarker, receiptStart) + receiptEndMarker.length;
  assert.notEqual(receiptStart, -1);
  assert.ok(receiptEnd >= receiptEndMarker.length);
  return `${source.slice(revokeStart, revokeEnd)}\n${source.slice(grantStart, grantEnd)}\n${source.slice(receiptStart, receiptEnd)}`;
}

function extractAuditSessionReadinessSql(sql) {
  const start = sql.indexOf('SELECT CASE\n  WHEN session_user');
  const endMarker = 'END AS audit_session_ready';
  const end = sql.indexOf(endMarker, start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return `${sql.slice(start, end + endMarker.length)};`;
}

function extractProvisionVerificationSql() {
  const source = readFileSync(provision, 'utf8');
  const startMarker = 'DO $verify$';
  const endMarker = '$verify$;';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return source.slice(start, end + endMarker.length);
}

test(
  'native provision and generic session allow only zero or eight effective receipt metadata grants',
  { skip: !nativePostgresUrl, timeout: 30_000 },
  async (t) => {
    const address = new URL(nativePostgresUrl);
    assert.ok(
      ['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) &&
        address.pathname.includes('race_test'),
      'Native grant integration requires disposable local PostgreSQL race_test',
    );
    const data = fixture();
    t.after(() => rmSync(data.directory, { force: true, recursive: true }));
    const emitted = runAudit(data, ['multibot-preparation']);
    assert.equal(emitted.status, 0, emitted.stderr);
    const { default: pg } = await import('pg');
    const client = new pg.Client({
      connectionString: nativePostgresUrl,
      connectionTimeoutMillis: 5000,
      query_timeout: 10_000,
      options: '-c statement_timeout=10000 -c lock_timeout=3000 -c timezone=UTC',
    });
    const namespace = `audit_grants_${randomUUID().replaceAll('-', '')}`;
    const role = `audit_grants_${randomUUID().replaceAll('-', '')}`;
    // FLAG: The complete production provision/session guards run with a unique
    // role and schema, never altering real public catalogs or shared role grants.
    const localSql = (sql) =>
      sql
        .replaceAll('public.', `${namespace}.`)
        .replaceAll("'public'", `'${namespace}'`)
        .replaceAll('maxim_audit', role);
    const resetSql = localSql(extractAuditColumnResetSql());
    const verificationSql = localSql(extractProvisionVerificationSql());
    const readinessSql = localSql(extractAuditSessionReadinessSql(readFileSync(data.sql, 'utf8')));
    const nativeBridge = join(data.directory, 'native-psql-bridge.mjs');
    // FLAG: Preserve the actual wrapper's generated input, resource options and
    // exit propagation. Only Docker transport and disposable role/schema differ.
    writeFileSync(
      nativeBridge,
      `import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const namespace = ${JSON.stringify(namespace)};
const role = ${JSON.stringify(role)};
const sql = readFileSync(0, 'utf8')
  .replaceAll('public.', namespace + '.')
  .replaceAll("'public'", "'" + namespace + "'")
  .replaceAll('maxim_audit', role);
writeFileSync(process.env.MOCK_AUDIT_SQL, sql);
const pgOptions = process.argv.slice(2).find((argument) => argument.startsWith('PGOPTIONS='));
if (!pgOptions) throw new Error('Native wrapper bridge requires actual PGOPTIONS');
const result = spawnSync('psql', ['-X', '--no-password', '-qAt', '-v', 'ON_ERROR_STOP=1',
  '-v', 'ECHO=none', '-v', 'VERBOSITY=terse', '-v', 'SHOW_CONTEXT=never'], {
  env: { ...process.env, PGOPTIONS: pgOptions.slice('PGOPTIONS='.length) },
  input: "SET temp_file_limit='8MB'; SET SESSION AUTHORIZATION " + role + ";\\n" + sql,
  encoding: 'utf8', timeout: 7000,
});
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exit(result.status ?? 1);
`,
    );
    const runNativeAudit = (args) =>
      runAudit(data, args, {
        MOCK_NATIVE_PSQL_BRIDGE: nativeBridge,
        PGHOST: address.hostname,
        PGPORT: address.port || '5432',
        PGUSER: decodeURIComponent(address.username),
        PGPASSWORD: decodeURIComponent(address.password),
        PGDATABASE: decodeURIComponent(address.pathname.slice(1)),
      });
    const runNativeWrapper = (explain = false) =>
      runNativeAudit(['multibot-preparation', ...(explain ? ['--explain'] : [])]);
    const assertWrapperRejected = () => {
      for (const explain of [false, true]) {
        const result = runNativeWrapper(explain);
        assert.equal(result.status, 3, result.stderr);
        assert.equal(result.stdout.trim(), 'MAXIM_POSTGRES_AUDIT_SESSION_INVALID');
        assert.doesNotMatch(
          result.stdout,
          /multibot_preparation|MULTIBOT_PREPARATION_RECEIPT_PRIVILEGES_INVALID/u,
        );
      }
    };
    let roleCreated = false;
    try {
      await client.connect();
      const identity = await client.query('SELECT version() AS version');
      assert.match(identity.rows[0].version, /^PostgreSQL /u);
      assert.doesNotMatch(identity.rows[0].version, /pglite|wasm/iu);
      await client.query(`
        CREATE SCHEMA ${namespace};
        SET search_path = ${namespace}, pg_catalog;
        CREATE TABLE webhook_events (id text);
        CREATE TABLE moderation_events (id text);
        CREATE TABLE chat_settings (
          id text, anti_duplicate_enabled bool, duplicate_photo_enabled bool,
          duplicate_detection_preset text, duplicate_photo_match_preset text,
          duplicate_photo_scope text, duplicate_compare_mode text, duplicate_window_mode text,
          duplicate_start_time_minutes int, duplicate_end_time_minutes int, duplicate_timezone text,
          private_extra text
        );
        CREATE TABLE moderation_delete_intents (id text, status text, updated_at timestamptz, private_extra text);
        CREATE TABLE moderation_delete_intent_reasons (intent_id text, reason_key text, rule_code text, private_extra text);
        CREATE TABLE publisher_entity_settings (
          chat_id text, chat_comments_enabled bool, chat_comments_admins_enabled bool,
          chat_comments_posts_enabled bool, channel_comments_enabled bool, updated_at timestamptz
        );
        CREATE TABLE chat_rules (
          chat_id text, published_message_id text, published_bot_id text, publish_operation_id text,
          publish_send_started_at timestamptz, pending_cleanup_message_id text,
          pending_cleanup_bot_id text, pending_cleanup_intent_id text, pending_cleanup_kind text,
          updated_at timestamptz, text text
        );
        ${readFileSync(resolve(root, 'infra/scripts/test-fixtures/publisher-publications.sql'), 'utf8')}
        CREATE ROLE ${role} LOGIN INHERIT CONNECTION LIMIT 1;
        GRANT USAGE ON SCHEMA ${namespace} TO ${role};
        GRANT SELECT ON webhook_events, moderation_events TO ${role};
        GRANT pg_read_all_stats TO ${role};
        SET max_parallel_workers_per_gather=0;
        SET enable_seqscan=off;
        SET enable_bitmapscan=off;
        SET jit=off;
        SET work_mem='1MB';
        SET temp_file_limit='8MB';
      `);
      roleCreated = true;
      const ready = async () => {
        await client.query(
          `SET default_transaction_read_only=on; SET SESSION AUTHORIZATION ${role};`,
        );
        try {
          return (await client.query(readinessSql)).rows[0].audit_session_ready;
        } finally {
          await client.query(
            'SET SESSION AUTHORIZATION DEFAULT; SET default_transaction_read_only=off;',
          );
        }
      };
      await client.query(resetSql);
      await client.query(verificationSql);
      assert.equal(await ready(), 'true', 'absent catalog remains compatible');
      await client.query('CREATE TABLE _prisma_migrations ()');
      await client.query(resetSql);
      await client.query(verificationSql);
      assert.equal(await ready(), 'true', 'empty old catalog receives zero grants');
      await client.query('GRANT SELECT ON _prisma_migrations TO PUBLIC');
      await assert.rejects(
        client.query(verificationSql),
        /receipt metadata privileges are not exact/u,
      );
      assert.equal(await ready(), 'false', 'table SELECT is rejected even without columns');
      await client.query(`REVOKE SELECT ON _prisma_migrations FROM PUBLIC;
        ALTER TABLE _prisma_migrations ADD id text, ADD private_extra text;`);
      await client.query(resetSql);
      await client.query(verificationSql);
      assert.equal(await ready(), 'true', 'partial catalog receives zero grants');
      await client.query(`GRANT SELECT (id) ON _prisma_migrations TO PUBLIC;`);
      await assert.rejects(
        client.query(verificationSql),
        /receipt metadata privileges are not exact/u,
      );
      assert.equal(await ready(), 'false', 'partial effective PUBLIC metadata fails closed');
      await client.query(`REVOKE SELECT (id) ON _prisma_migrations FROM PUBLIC;
        ALTER TABLE _prisma_migrations ADD migration_name text, ADD checksum text,
          ADD started_at timestamptz, ADD finished_at timestamptz, ADD rolled_back_at timestamptz,
          ADD applied_steps_count int, ADD logs text;
        GRANT SELECT (private_extra), UPDATE (id) ON _prisma_migrations TO ${role};`);
      await client.query(resetSql);
      await client.query(resetSql);
      await client.query(verificationSql);
      assert.equal(await ready(), 'true', 'convergence admits exact receipt metadata');
      let actualWrapper = runNativeWrapper();
      assert.equal(actualWrapper.status, 0, actualWrapper.stderr);
      assert.equal(JSON.parse(actualWrapper.stdout).audit, 'multibot_preparation');
      actualWrapper = runNativeWrapper(true);
      assert.equal(actualWrapper.status, 0, actualWrapper.stderr);
      assert.ok(Array.isArray(JSON.parse(actualWrapper.stdout)));
      for (const [args, marker] of [
        [['queue'], 'MAXIM_POSTGRES_QUEUE_AUDIT_INDEX_MISSING'],
        [['monitor-signals', '60'], 'MAXIM_POSTGRES_MONITOR_AUDIT_INDEX_MISSING'],
        [['duplicate'], 'MAXIM_POSTGRES_DUPLICATE_AUDIT_UNAVAILABLE'],
        [['duplicate', '--explain'], 'MAXIM_POSTGRES_DUPLICATE_AUDIT_UNAVAILABLE'],
      ]) {
        const result = runNativeAudit(args);
        assert.equal(result.status, 3, result.stderr);
        assert.equal(result.stdout.trim(), marker, 'missing indexes emit no report');
      }
      for (const [grant, revoke] of [
        ['SELECT (private_extra) TO PUBLIC', 'SELECT (private_extra) FROM PUBLIC'],
        ['UPDATE (id) TO PUBLIC', 'UPDATE (id) FROM PUBLIC'],
        ['REFERENCES (id) TO PUBLIC', 'REFERENCES (id) FROM PUBLIC'],
        [
          'SELECT (private_extra) TO pg_read_all_stats',
          'SELECT (private_extra) FROM pg_read_all_stats',
        ],
        ['SELECT TO PUBLIC', 'SELECT FROM PUBLIC'],
      ]) {
        const command = (verb, spec) =>
          `${verb} ${spec.replace(' TO ', ' ON _prisma_migrations TO ').replace(' FROM ', ' ON _prisma_migrations FROM ')}`;
        await client.query(command('GRANT', grant));
        await assert.rejects(
          client.query(verificationSql),
          /receipt metadata privileges are not exact/u,
        );
        assert.equal(await ready(), 'false', grant);
        assertWrapperRejected();
        await client.query(command('REVOKE', revoke));
        await client.query(verificationSql);
        assert.equal(await ready(), 'true');
      }
      await client.query(`REVOKE SELECT (logs) ON _prisma_migrations FROM ${role}`);
      await assert.rejects(
        client.query(verificationSql),
        /receipt metadata privileges are not exact/u,
      );
      assert.equal(await ready(), 'false', 'seven metadata grants fail closed');
      assertWrapperRejected();
      await client.query(resetSql);
      await client.query(verificationSql);
      assert.equal(await ready(), 'true');
      // FLAG: The generic session permits legacy zero duplicate grants, but both
      // duplicate modes must reject before any report even with all exact indexes.
      await client.query(`
        ALTER TABLE chat_settings ADD PRIMARY KEY (id);
        ALTER TABLE moderation_events ADD created_at timestamptz;
        CREATE INDEX moderation_events_created_at_idx ON moderation_events (created_at);
        CREATE INDEX moderation_delete_intents_retention_idx ON moderation_delete_intents (status, updated_at);
        CREATE UNIQUE INDEX moderation_delete_intent_reasons_intent_reason_key
          ON moderation_delete_intent_reasons (intent_id, reason_key);
      `);
      assert.equal(runAudit(data, ['duplicate']).status, 0);
      const duplicateReadiness = localSql(
        extractDuplicateReadinessSql(readFileSync(data.sql, 'utf8')),
      );
      assert.equal(
        (await client.query(duplicateReadiness)).rows[0].duplicate_audit_ready,
        'true',
        'all four exact indexes and seventeen grants are admitted',
      );
      await client.query(`
        REVOKE SELECT (id, anti_duplicate_enabled, duplicate_photo_enabled,
          duplicate_detection_preset, duplicate_photo_match_preset, duplicate_photo_scope,
          duplicate_compare_mode, duplicate_window_mode, duplicate_start_time_minutes,
          duplicate_end_time_minutes, duplicate_timezone) ON chat_settings FROM ${role};
        REVOKE SELECT (id, status, updated_at) ON moderation_delete_intents FROM ${role};
        REVOKE SELECT (intent_id, reason_key, rule_code) ON moderation_delete_intent_reasons FROM ${role};
      `);
      assert.equal(await ready(), 'true', 'legacy zero duplicate grant group remains compatible');
      for (const explain of [false, true]) {
        const result = runNativeAudit(['duplicate', ...(explain ? ['--explain'] : [])]);
        assert.equal(result.status, 3, result.stderr);
        assert.equal(result.stdout.trim(), 'MAXIM_POSTGRES_DUPLICATE_AUDIT_UNAVAILABLE');
      }
    } finally {
      await client
        .query('SET SESSION AUTHORIZATION DEFAULT; SET default_transaction_read_only=off;')
        .catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`).catch(() => {});
      if (roleCreated) await client.query(`DROP ROLE ${role}`).catch(() => {});
      await client.end();
    }
  },
);

test('commercial quality mode is opt-in, fixed, indexed and preserves the bounded audit envelope', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  assert.equal(runAudit(data, ['commercial-quality']).status, 0);
  const emitted = readFileSync(data.sql, 'utf8');
  assert.match(emitted, /commercial_quality_privileges_ready/u);
  assert.match(emitted, /commercial_review_samples_blind_queue_idx/u);
  assert.match(emitted, /ORDER BY observed_at DESC, id DESC LIMIT 5001/u);
  assert.match(emitted, /'population_basis', 'captured_review_samples_not_all_messages'/u);
  assert.match(readFileSync(data.dockerArgs, 'utf8'), /statement_timeout=2500ms/u);
  assert.equal(runConnect(data, ['postgres-audit', 'commercial-quality', '--explain']).status, 0);
  assert.match(readFileSync(data.sshArgs, 'utf8'), /commercial-quality/u);
  assert.equal(runAudit(data, ['commercial-quality', '--explain']).status, 0);
  assert.match(readFileSync(data.sql, 'utf8'), /EXPLAIN \(FORMAT JSON\) WITH candidates/u);
  assert.doesNotMatch(readFileSync(data.sql, 'utf8'), /EXPLAIN\s+ANALYZE/iu);
  for (const arg of ['SELECT 1', '--file', '/tmp/private', 'private-chat']) {
    assert.equal(runAudit(data, ['commercial-quality', arg]).status, 2);
    assert.equal(runConnect(data, ['postgres-audit', 'commercial-quality', arg]).status, 2);
  }
  assert.equal(runAudit(data, ['all']).status, 0);
  assert.doesNotMatch(readFileSync(data.sql, 'utf8'), /'audit', 'commercial_quality'/u);
});

test('rules cleanup audit accepts only an exact chat ID and never operator SQL', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  const result = runAudit(data, ['rules-cleanup', '-123', '--explain']);
  assert.equal(result.status, 0, result.stderr);
  const sql = readFileSync(data.sql, 'utf8');
  assert.match(sql, /EXPLAIN \(FORMAT JSON\) SELECT/u);
  assert.match(sql, /WHERE rules\.chat_id = '-123'/u);
  assert.doesNotMatch(sql, /EXPLAIN ANALYZE|rules\.text|image_base64/u);
  assert.equal(runConnect(data, ['postgres-audit', 'rules-cleanup', '-123']).status, 0);
  for (const value of [
    '',
    '123',
    '-0',
    '-1\n',
    '-01',
    "-1' OR true --",
    '/tmp/query.sql',
    '-123;DELETE',
    '-123456789012345678901',
  ]) {
    assert.throws(() => buildRulesCleanupAuditSql(value));
    assert.notEqual(runAudit(data, ['rules-cleanup', value]).status, 0);
    assert.notEqual(runConnect(data, ['postgres-audit', 'rules-cleanup', value]).status, 0);
  }
  assert.notEqual(runAudit(data, ['rules-cleanup', '-123', '--apply']).status, 0);
  assert.notEqual(
    runConnect(data, ['postgres-audit', 'rules-cleanup', '-123', 'SELECT 1']).status,
    0,
  );
});

test('storage audit is opt-in, uses the bounded audit role, and rejects operator SQL', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  assert.equal(runAudit(data, ['storage']).status, 0);
  const sql = readFileSync(data.sql, 'utf8');
  assert.match(sql, /'audit', 'postgres_storage'/u);
  assert.match(sql, /BEGIN READ ONLY/u);
  assert.match(readFileSync(data.dockerArgs, 'utf8'), /maxim_audit/u);
  assert.equal(runConnect(data, ['postgres-audit', 'storage']).status, 0);
  assert.match(readFileSync(data.sshArgs, 'utf8'), /vps-postgres-audit\.sh\\ storage/u);
  assert.equal(runAudit(data, ['storage', 'SELECT 1']).status, 2);
  assert.equal(runConnect(data, ['postgres-audit', 'storage', 'SELECT 1']).status, 2);
  assert.equal(runAudit(data, ['storage', '--explain']).status, 0);
  assert.match(readFileSync(data.sql, 'utf8'), /EXPLAIN \(FORMAT JSON\)/u);
  assert.equal(runConnect(data, ['postgres-audit', 'storage', '--explain']).status, 0);
  assert.equal(runAudit(data, ['all']).status, 0);
  assert.doesNotMatch(readFileSync(data.sql, 'utf8'), /'audit', 'postgres_storage'/u);
});

test('multibot preparation diagnostics are fixed, read-only and opt-in', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  assert.equal(runAudit(data, ['multibot-preparation']).status, 0);
  const sql = readFileSync(data.sql, 'utf8');
  assert.match(sql, /BEGIN READ ONLY/u);
  assert.match(sql, /multibot_preparation/u);
  assert.match(sql, /webhook_events_semantic_order_idx/u);
  assert.match(readFileSync(data.dockerArgs, 'utf8'), /maxim_audit/u);
  assert.equal(runConnect(data, ['postgres-audit', 'multibot-preparation']).status, 0);
  assert.match(
    readFileSync(data.sshArgs, 'utf8'),
    /vps-postgres-audit\.sh\\ multibot-preparation/u,
  );
  for (const argument of ['--apply', 'SELECT 1', '/tmp/operator.sql']) {
    assert.equal(runAudit(data, ['multibot-preparation', argument]).status, 2);
    assert.equal(runConnect(data, ['postgres-audit', 'multibot-preparation', argument]).status, 2);
  }
  assert.equal(runAudit(data, ['multibot-preparation', '--explain']).status, 0);
  assert.match(readFileSync(data.sql, 'utf8'), /EXPLAIN \(FORMAT JSON\)/u);
  assert.equal(runAudit(data, ['all']).status, 0);
  assert.doesNotMatch(readFileSync(data.sql, 'utf8'), /multibot_preparation/u);
});

test('owner proof is opt-in, fixed, preserves cleanup and suppresses raw database errors', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  for (const options of [[], ['--explain']]) {
    assert.equal(runAudit(data, ['webhook-owner-proof', ...options]).status, 0);
    const sql = readFileSync(data.sql, 'utf8');
    assert.match(sql, /owner_proof_privileges_ready/u);
    assert.match(sql, /owner_proof_indexes_ready/u);
    assert.match(sql, /'audit', 'webhook_owner_proof'/u);
    assert.equal(sql.includes('EXPLAIN (FORMAT JSON)'), options.length > 0);
    assert.equal(runConnect(data, ['postgres-audit', 'webhook-owner-proof', ...options]).status, 0);
  }
  for (const options of [['SELECT 1'], ['--apply'], ['--explain', 'anything']]) {
    assert.equal(runAudit(data, ['webhook-owner-proof', ...options]).status, 2);
    assert.equal(runConnect(data, ['postgres-audit', 'webhook-owner-proof', ...options]).status, 2);
  }
  const failed = runAudit(data, ['webhook-owner-proof'], { MOCK_AUDIT_FAIL: '1' });
  assert.equal(failed.status, 7);
  assert.match(failed.stderr, /owner_proof_unavailable/u);
  assert.doesNotMatch(failed.stdout + failed.stderr, /fixture-event-0001|ERROR near/u);
  assert.match(readFileSync(data.cleanupArgs, 'utf8'), /pg_terminate_backend/u);
  assert.equal(runAudit(data, ['all']).status, 0);
  assert.doesNotMatch(readFileSync(data.sql, 'utf8'), /'audit', 'webhook_owner_proof'/u);
});

test('queue audit uses the dedicated role and a hard read-only resource envelope', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));

  const result = runAudit(data, ['queue']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '{"mock":true}');

  const args = readFileSync(data.dockerArgs, 'utf8');
  assert.match(args, /maxim_audit/u);
  assert.match(args, /default_transaction_read_only=on/u);
  assert.match(args, /statement_timeout=2500ms/u);
  assert.match(args, /lock_timeout=250ms/u);
  assert.match(args, /idle_in_transaction_session_timeout=4s/u);
  assert.match(args, /idle_session_timeout=60s/u);
  assert.match(args, /max_parallel_workers_per_gather=0/u);
  assert.match(args, /enable_seqscan=off/u);
  assert.match(args, /enable_bitmapscan=off/u);
  assert.match(args, /jit=off/u);
  assert.match(args, /work_mem=1MB/u);
  assert.match(args, /--no-password/u);
  assert.match(args, /ECHO=none/u);
  assert.match(args, /VERBOSITY=terse/u);
  assert.match(args, /SHOW_CONTEXT=never/u);

  const sql = readFileSync(data.sql, 'utf8');
  assert.match(sql, /^BEGIN READ ONLY;$/mu);
  assert.match(sql, /session_user = 'maxim_audit'/u);
  assert.match(sql, /NOT rolsuper/u);
  assert.match(sql, /NOT rolbypassrls/u);
  assert.match(sql, /pg_has_role\('maxim_audit', 'pg_read_all_stats', 'member'\)/u);
  assert.match(sql, /NOT pg_has_role\('maxim_audit', 'pg_read_all_data', 'member'\)/u);
  assert.match(sql, /information_schema\.role_table_grants/u);
  assert.match(sql, /FROM pg_class relation/u);
  assert.match(
    sql,
    /has_table_privilege\([\s\S]*INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER/u,
  );
  assert.match(sql, /has_column_privilege\([\s\S]*INSERT,UPDATE,REFERENCES/u);
  assert.match(sql, /restricted_relation[\s\S]*restricted_attribute/u);
  assert.match(sql, /has_column_privilege\([\s\S]*restricted_attribute\.attnum,[\s\S]*'SELECT'/u);
  assert.match(sql, /current_setting\('enable_bitmapscan'\) = 'off'/u);
  assert.match(sql, /pg_size_bytes\(current_setting\('temp_file_limit'\)\) BETWEEN 0 AND 8388608/u);
  assert.match(sql, /MAXIM_POSTGRES_AUDIT_SESSION_INVALID\nSELECT 1 \/ 0;/u);
  assert.match(sql, /to_regclass\('public\.webhook_events_status_created_at_idx'\)/u);
  assert.match(sql, /bounded_events AS MATERIALIZED/u);
  assert.match(sql, /WHERE webhook_events\.status = queue_statuses\.status/u);
  assert.match(sql, /ORDER BY webhook_events\.created_at ASC\n {4}LIMIT 2001/u);
  assert.match(sql, /'sample_cap_per_status', 2000/u);
  assert.doesNotMatch(
    sql.slice(sql.indexOf('WITH queue_statuses(status) AS')),
    /raw_payload|source_ip|user_id|masked_excerpt/u,
  );
  assert.doesNotMatch(
    sql,
    /'error_message'|'next_enqueue_at'|'normalized_payload'|'message_chat_id'/u,
  );
  assert.match(sql, /WHERE webhook_events\.status = summary\.status[\s\S]*LIMIT 1/u);
  assert.match(sql, /'oldest_preparation_state', oldest\.preparation_state/u);
  assert.match(schema, /@@index\(\[status, createdAt\]\)/u);

  const appName = /PGAPPNAME=(maxim-bounded-audit-[A-Za-z0-9-]+)/u.exec(args)?.[1];
  assert.ok(appName);
  assert.ok(appName.length <= 63);
  const cleanup = readFileSync(data.cleanupArgs, 'utf8');
  assert.match(cleanup, /-U\nmaxim\n/u);
  assert.match(cleanup, new RegExp(`application_name = '${appName}'`, 'u'));
  assert.match(cleanup, /pg_terminate_backend\(live\.pid\)/u);
  assert.match(cleanup, /candidate AS MATERIALIZED/u);
  assert.match(cleanup, /LIMIT 2/u);
  assert.match(cleanup, /HAVING count\(\*\) = 1/u);
  assert.match(cleanup, /live\.pid = singleton\.pid/u);
  assert.match(cleanup, /live\.backend_start = singleton\.backend_start/u);
  const auditSource = readFileSync(audit, 'utf8');
  assert.match(auditSource, /timeout --signal=TERM --kill-after=1s 4s[\s\\]+docker compose/u);
});

test('Publisher comments audit is exact-key, metadata-only and rejects operator SQL', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  assert.equal(runAudit(data, ['publisher-comments', '-123', '--explain']).status, 0);
  assert.equal(runConnect(data, ['postgres-audit', 'publisher-comments', '-123']).status, 0);
  const sql = readFileSync(data.sql, 'utf8');
  assert.match(sql, /EXPLAIN \(FORMAT JSON\) SELECT/u);
  assert.match(sql, /FROM \(VALUES \('-123'\)\)/u);
  assert.doesNotMatch(
    buildPublisherCommentsAuditSql('-123'),
    /audit_logs|webhook_events|payload|permissions_snapshot|publisher_bot_id|EXPLAIN ANALYZE/u,
  );
  for (const value of ['', '123', '-0', '-01', '-1\n', "-1' OR true --", '/tmp/query.sql']) {
    assert.throws(() => buildPublisherCommentsAuditSql(value));
    assert.notEqual(runAudit(data, ['publisher-comments', value]).status, 0);
    assert.notEqual(runConnect(data, ['postgres-audit', 'publisher-comments', value]).status, 0);
  }
  assert.notEqual(runAudit(data, ['publisher-comments', '-123', '--apply']).status, 0);
});

test('activity audit exposes only fixed workload categories and aggregate backend state', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));

  const result = runAudit(data, ['activity']);
  assert.equal(result.status, 0, result.stderr);
  const sql = readFileSync(data.sql, 'utf8');
  assert.match(sql, /FROM pg_stat_activity/u);
  assert.match(sql, /'scheduled_backup'|'live_backup'|'bounded_audit'|'unspecified'|'other'/u);
  assert.match(sql, /grouped_activity AS MATERIALIZED/u);
  assert.match(sql, /LIMIT 64/u);
  assert.match(sql, /'query_family', query_family/u);
  assert.match(sql, /WHEN application_name = 'api-action' THEN 'action'/u);
  assert.match(sql, /WHEN application_name = 'api-enqueue' THEN 'enqueue'/u);
  assert.doesNotMatch(sql, /\bclient_addr\b|\busename\b/u);
  assert.doesNotMatch(sql, /'application_name'|'query'/u);
});

test('activity query classification emits only fixed labels, including for sensitive query text', async (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  const result = runAudit(data, ['activity']);
  assert.equal(result.status, 0, result.stderr);
  const sql = readFileSync(data.sql, 'utf8');
  const start = sql.indexOf('WITH classified_activity AS MATERIALIZED');
  const end = sql.indexOf('FROM grouped_activity;', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const statement = sql.slice(start, end + 'FROM grouped_activity;'.length);
  const database = new PGlite();
  t.after(() => database.close());
  await database.exec(`
    CREATE TABLE fixture_activity (
      application_name text, backend_type text, state text, wait_event_type text,
      wait_event text, query_start timestamptz, xact_start timestamptz,
      datname text DEFAULT current_database(), pid integer, query text
    );
  `);
  const cases = [
    [
      'active',
      '/* fair_enqueue_candidates */ SELECT secret_payload FROM webhook_events',
      'webhook_enqueue_selection',
    ],
    [
      'active',
      'WITH requested_chats AS () SELECT secret_payload FROM webhook_events',
      'webhook_ordered_heads',
    ],
    ['active', 'SELECT secret_payload FROM webhook_execution_claims', 'webhook_execution_claims'],
    ['active', 'SELECT secret_payload FROM webhook_events', 'webhook_events'],
    ['active', 'SELECT secret_payload FROM moderation_delete_intents', 'moderation_delete_intents'],
    ['active', 'SELECT secret_payload FROM max_action_ledger', 'max_action_ledger'],
    ['active', 'SELECT secret_payload FROM moderation_events', 'moderation_events'],
    ['active', 'SELECT secret_payload FROM chat_message_history', 'chat_message_history'],
    ['active', 'SELECT secret_payload FROM unknown_table', 'other'],
    ['idle', 'SELECT secret_payload FROM webhook_events', 'inactive'],
    ['active', 'SELECT secret_payload FROM chat_settings', 'chat_settings'],
    ['active', 'SELECT secret_payload FROM chat_bot_memberships', 'chat_bot_memberships'],
    ['active', 'SELECT secret_payload FROM managed_entity_access_edges', 'managed_entity_access'],
    ['active', 'SELECT secret_payload FROM managed_bot_chat_catalog', 'managed_bot_catalog'],
    ['active', 'SELECT secret_payload FROM night_mode_transition_reconcile_requests', 'night_mode'],
    ['active', 'SELECT secret_payload FROM spammer_observations', 'spammer_intelligence'],
    ['active', 'SELECT secret_payload FROM publication_occurrences', 'publisher'],
    ['active', 'SELECT secret_payload FROM managed_broadcasts', 'managed_publication'],
    ['active', 'SELECT secret_payload FROM managed_polls', 'managed_polls'],
    ['active', 'SELECT secret_payload FROM managed_giveaways', 'managed_giveaways'],
    ['active', 'SELECT secret_payload FROM vk_parsing_posts', 'vk_parsing'],
    [
      'active',
      'SELECT secret_payload FROM chat_auto_comment_attach_markers',
      'message_replacements',
    ],
    ['active', 'SELECT secret_payload FROM chat_rules', 'chat_rules'],
    ['active', 'SELECT secret_payload FROM chat_user_display_names', 'user_display_names'],
    ['active', 'SELECT secret_payload FROM chat_membership_activity_events', 'statistics'],
    ['active', 'SELECT secret_payload FROM audit_logs', 'audit_logs'],
    [
      'active',
      'SELECT "intent"."commercial_ocr_guard_required", "intent"."routing_policy"',
      'moderation_delete_intent_projection',
    ],
    ['active', 'SELECT secret_payload FROM "chats"', 'chats'],
    ['active', 'VACUUM secret_table', 'maintenance'],
  ];
  for (const [state, query] of cases) {
    await database.query(
      `INSERT INTO fixture_activity (application_name, backend_type, state, pid, query)
       VALUES ('private-application', 'client backend', $1, -1, $2)`,
      [state, query],
    );
  }
  const { rows } = await database.query(
    statement.replace('FROM pg_stat_activity', 'FROM fixture_activity'),
  );
  const report = JSON.parse(Object.values(rows[0])[0]);
  assert.deepEqual(
    report.rows.map((row) => row.query_family).sort(),
    cases.map(([, , family]) => family).sort(),
  );
  assert.ok(report.rows.every((row) => row.sessions === 1));
  assert.doesNotMatch(JSON.stringify(report), /secret_payload|private-application|unknown_table/u);
  await database.query(
    `UPDATE fixture_activity SET application_name = 'api-action', query = $1
      WHERE query LIKE '%unknown_table%'`,
    [`SELECT audit."payload"->>'private-field' FROM audit_logs audit`],
  );
  const actionResult = await database.query(
    statement.replace('FROM pg_stat_activity', 'FROM fixture_activity'),
  );
  const actionReport = JSON.parse(Object.values(actionResult.rows[0])[0]);
  const actionRow = actionReport.rows.find((row) => row.workload === 'action');
  assert.equal(actionRow.query_family, 'audit_logs');
  assert.equal(actionRow.query_shape, 'audit_json_raw');
  assert.doesNotMatch(JSON.stringify(actionReport), /private-field|api-action/u);
  await database.query(
    `UPDATE fixture_activity SET application_name = 'api-publisher', query = $1
      WHERE application_name = 'api-action'`,
    ['/* FLAG: publisher_suggestion_legacy_migration */ SELECT secret_payload FROM audit_logs'],
  );
  const markedResult = await database.query(
    statement.replace('FROM pg_stat_activity', 'FROM fixture_activity'),
  );
  const markedReport = JSON.parse(Object.values(markedResult.rows[0])[0]);
  assert.equal(
    markedReport.rows.find((row) => row.workload === 'publisher').query_shape,
    'publisher_legacy_migration',
  );
  assert.doesNotMatch(JSON.stringify(markedReport), /secret_payload|api-publisher/u);
  for (const [marker, table] of [
    ['delete_lease_renew', 'moderation_delete_intents'],
    ['vk_import_upsert', 'vk_parsing_posts'],
  ]) {
    await database.query(
      `UPDATE fixture_activity SET query = $1 WHERE application_name = 'api-publisher'`,
      [`/* storage:${marker} */ UPDATE ${table} SET private_field = 'secret_payload'`],
    );
    const sampled = await database.query(
      statement.replace('FROM pg_stat_activity', 'FROM fixture_activity'),
    );
    const data = JSON.parse(Object.values(sampled.rows[0])[0]);
    assert.equal(data.rows.find((row) => row.workload === 'publisher').query_shape, marker);
    assert.doesNotMatch(JSON.stringify(data), /secret_payload|private_field/u);
  }
});

function extractQueueReportSql(sql) {
  const start = sql.indexOf('WITH queue_statuses(status) AS');
  const end = sql.indexOf(') predecessor ON TRUE;', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return sql.slice(start, end + ') predecessor ON TRUE;'.length);
}

function extractLegacyOrderCandidatesSql(sql) {
  const start = sql.indexOf('WITH oldest_received AS MATERIALIZED (');
  const marker = 'LEFT JOIN candidate_parts candidate ON TRUE;';
  const end = sql.indexOf(marker, start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return sql.slice(start, end + marker.length);
}

function extractLegacyOrderCandidatesReadinessSql(sql) {
  const start = sql.indexOf('SELECT CASE\n  WHEN (\n    SELECT count(*) = 2');
  const marker = 'END AS legacy_order_candidates_index_ready';
  const end = sql.indexOf(marker, start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return `${sql.slice(start, end + marker.length)};`;
}

test('legacy order candidates are opt-in, input-free and keep the guarded private envelope', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  const result = runAudit(data, ['legacy-order-candidates']);
  assert.equal(result.status, 0, result.stderr);
  const sql = readFileSync(data.sql, 'utf8');
  const statement = extractLegacyOrderCandidatesSql(sql);
  assert.match(sql, /^BEGIN READ ONLY;$/mu);
  assert.match(sql, /session_user = 'maxim_audit'/u);
  assert.match(sql, /webhook_events_status_created_at_id_idx/u);
  assert.match(sql, /webhook_events_ordered_chat_head_idx/u);
  assert.match(
    sql,
    /index_state\.indisvalid AND index_state\.indisready AND index_state\.indislive/u,
  );
  assert.match(sql, /pg_get_expr\(index_state\.indexprs, index_state\.indrelid\)/u);
  assert.match(sql, /pg_get_expr\(index_state\.indpred, index_state\.indrelid\)/u);
  assert.match(sql, /unnest\(index_state\.indoption::smallint\[\]\)/u);
  assert.match(sql, /MAXIM_POSTGRES_LEGACY_ORDER_CANDIDATES_INDEX_UNAVAILABLE/u);
  assert.equal([...statement.matchAll(/FROM webhook_events\b/gu)].length, 2);
  assert.equal([...statement.matchAll(/\bLIMIT 1\b/gu)].length, 2);
  assert.match(
    statement,
    /oldest_received AS MATERIALIZED \([\s\S]*WHERE status = 'RECEIVED'[\s\S]*ORDER BY created_at ASC, id ASC\n {2}LIMIT 1/u,
  );
  assert.match(statement, /bounded_predecessor AS MATERIALIZED/u);
  assert.ok(
    statement.indexOf('LIMIT 1\n  ) predecessor') <
      statement.indexOf('classified_candidate AS MATERIALIZED'),
  );
  assert.doesNotMatch(
    statement,
    /raw_payload|source_ip|webhook_execution_claims|moderation_delete_intents|COUNT\(|GROUP BY|DISTINCT/u,
  );
  const projection = statement.slice(statement.indexOf('SELECT json_build_object('));
  assert.doesNotMatch(
    projection,
    /^\s*'(?:chat_id|user_id|text|body|payload|token|error|owner)',/mu,
  );
  assert.match(projection, /'candidate_receipt_id'/u);
  assert.match(projection, /'scope', 'oldest_received_only'/u);
  const args = readFileSync(data.dockerArgs, 'utf8');
  for (const required of [
    'maxim_audit',
    'default_transaction_read_only=on',
    'statement_timeout=2500ms',
    'lock_timeout=250ms',
    'max_parallel_workers_per_gather=0',
    'enable_seqscan=off',
    'enable_bitmapscan=off',
    'work_mem=1MB',
    'ECHO=none',
    'SHOW_CONTEXT=never',
  ])
    assert.ok(args.includes(required), required);
  const failed = runAudit(data, ['legacy-order-candidates'], { MOCK_AUDIT_FAIL: '1' });
  assert.equal(failed.status, 7, failed.stderr);
  assert.match(failed.stderr, /Bounded legacy order candidate audit failed closed/u);
  assert.doesNotMatch(`${failed.stdout}${failed.stderr}`, /fixture-event|ERROR near/u);
  for (const mode of ['all', 'monitor-signals']) {
    assert.equal(runAudit(data, mode === 'all' ? ['all'] : ['monitor-signals', '30']).status, 0);
    assert.doesNotMatch(
      readFileSync(data.sql, 'utf8'),
      /legacy_order_candidates|candidate_receipt_id/u,
    );
  }
  assert.equal(runConnect(data, ['postgres-audit', 'legacy-order-candidates']).status, 0);
  assert.match(readFileSync(data.sshArgs, 'utf8'), /legacy-order-candidates/u);
  for (const extra of ['--explain', '--apply', 'SELECT 1', 'c1111111111111111111111111']) {
    rmSync(data.dockerArgs, { force: true });
    rmSync(data.sshArgs, { force: true });
    assert.equal(runAudit(data, ['legacy-order-candidates', extra]).status, 2);
    assert.equal(runConnect(data, ['postgres-audit', 'legacy-order-candidates', extra]).status, 2);
    assert.equal(existsSync(data.dockerArgs), false);
    assert.equal(existsSync(data.sshArgs), false);
  }
});

test('legacy order window keeps the private envelope and accepts only plain explain', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  assert.equal(runAudit(data, ['legacy-order-window']).status, 0);
  const sql = readFileSync(data.sql, 'utf8');
  assert.match(sql, /BEGIN READ ONLY/u);
  assert.match(sql, /ORDER BY created_at, id LIMIT 129/u);
  assert.match(sql, /ORDER BY created_at, id LIMIT 128/u);
  assert.match(sql, /ORDER BY created_at, id LIMIT 32/u);
  assert.match(sql, /legacy_order_candidates_index_ready/u);
  assert.equal(runAudit(data, ['legacy-order-window', '--explain']).status, 0);
  assert.match(readFileSync(data.sql, 'utf8'), /EXPLAIN \(FORMAT JSON\)/u);
  assert.doesNotMatch(readFileSync(data.sql, 'utf8'), /EXPLAIN ANALYZE/u);
  assert.equal(runConnect(data, ['postgres-audit', 'legacy-order-window', '--explain']).status, 0);
  for (const extra of ['--apply', 'SELECT 1', '/tmp/query.sql']) {
    rmSync(data.dockerArgs, { force: true });
    rmSync(data.sshArgs, { force: true });
    assert.equal(runAudit(data, ['legacy-order-window', extra]).status, 2);
    assert.equal(runConnect(data, ['postgres-audit', 'legacy-order-window', extra]).status, 2);
    assert.equal(existsSync(data.dockerArgs), false);
    assert.equal(existsSync(data.sshArgs), false);
  }
});

test('legacy candidate classification never skips an earlier unknown fence or leaks source data', async (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  assert.equal(runAudit(data, ['legacy-order-candidates']).status, 0);
  const sql = readFileSync(data.sql, 'utf8');
  const statement = extractLegacyOrderCandidatesSql(sql);
  const readiness = extractLegacyOrderCandidatesReadinessSql(sql);
  const database = new PGlite();
  t.after(() => database.close());
  await database.exec(`
    CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'QUEUED', 'FAILED');
    CREATE TABLE webhook_events (
      id text PRIMARY KEY, status "WebhookStatus", created_at timestamp,
      error_message text, next_enqueue_at timestamp, timeout_quarantine_expires_at timestamp,
      processed_at timestamp, normalized_payload jsonb DEFAULT '{}'
    );
    CREATE INDEX webhook_events_status_created_at_id_idx ON webhook_events(status, created_at, id);
  `);
  assert.equal(
    (await database.query(readiness)).rows[0].legacy_order_candidates_index_ready,
    'false',
  );
  const orderedIndexSql = readFileSync(
    resolve(
      root,
      'apps/api/prisma/migrations/20260815123000_add_webhook_ordered_chat_head_index/migration.sql',
    ),
    'utf8',
  ).replace('CREATE INDEX CONCURRENTLY', 'CREATE INDEX');
  await database.exec(orderedIndexSql);
  const candidateId = 'c1111111111111111111111111';
  const legacy =
    'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required';
  const payload = JSON.stringify({
    type: 'message_created',
    token: 'private-token',
    message: {
      chatId: 'private-chat',
      userId: 'private-user',
      messageId: 'private-message',
      text: 'private-body',
    },
  });
  const report = async (classification, id = null) => {
    const result = await database.query(statement);
    const value = JSON.parse(Object.values(result.rows[0])[0]);
    assert.deepEqual(Object.keys(value), [
      'schema_version',
      'audit',
      'scope',
      'receipt_sample_cap',
      'predecessor_sample_cap',
      'candidate_count',
      'candidate_receipt_id',
      'classification',
      'source_shape',
    ]);
    assert.equal(value.classification, classification);
    assert.equal(value.candidate_receipt_id, id);
    assert.equal(value.candidate_count, id === null ? 0 : 1);
    assert.equal(value.receipt_sample_cap, 1);
    assert.equal(value.predecessor_sample_cap, 1);
    assert.equal(value.schema_version, 2);
    if (id === null) assert.equal(value.source_shape, null);
    else {
      assert.equal(value.source_shape.diagnostics_only, true);
      assert.ok(
        Object.values(value.source_shape).every(
          (entry) =>
            entry === null ||
            typeof entry === 'boolean' ||
            ['object', 'array', 'string', 'number', 'boolean', 'null'].includes(entry),
        ),
      );
    }
    assert.doesNotMatch(
      JSON.stringify(value),
      /private-|LEGACY_EXECUTION|CANONICAL_BUSINESS|message_created|FAILED/u,
    );
  };
  assert.equal(
    (await database.query(readiness)).rows[0].legacy_order_candidates_index_ready,
    'true',
  );
  await report('no_received');
  await database.query(
    `INSERT INTO webhook_events(id, status, created_at, error_message, normalized_payload)
    VALUES ($1, 'FAILED', '2026-01-01', $2, $3::jsonb),
      ('private-received-z', 'RECEIVED', '2026-01-02', NULL, $3::jsonb)`,
    [candidateId, legacy, payload],
  );
  await report('legacy_unverified_candidate', candidateId);
  const source = JSON.parse(payload);
  source.botId = 'private-bot';
  source.message.entityType = 'chat';
  source.message.senderId = 'private-user';
  source.message.createdAt = '2026-01-01T00:00:00.000Z';
  source.raw = {
    update_type: 'message_created',
    timestamp: 1767225600000,
    message: {
      timestamp: 1767225600000,
      sender: { user_id: 'private-user', name: 'private-name', is_bot: false },
      recipient: { chat_id: 'private-chat', chat_type: 'chat', user_id: null },
      body: { mid: 'private-message', text: 'private-body', attachments: null },
    },
  };
  const shape = async (update) => {
    await database.query('UPDATE webhook_events SET normalized_payload = $1::jsonb WHERE id = $2', [
      JSON.stringify(update),
      candidateId,
    ]);
    await report('legacy_unverified_candidate', candidateId);
    return JSON.parse(Object.values((await database.query(statement)).rows[0])[0]).source_shape;
  };
  const nullable = await shape(source);
  assert.equal(nullable.recipient_keys_supported, false);
  assert.equal(nullable.recipient_nullable_actor, true);
  assert.equal(nullable.attachments_kind, 'null');
  assert.equal(nullable.actor_is_human, true);
  assert.equal(nullable.content_matches, true);
  assert.equal(nullable.original_content_kind, 'string');
  assert.equal(nullable.chat_identity_matches, true);
  assert.equal(nullable.message_identity_matches, true);
  assert.equal(nullable.actor_identity_matches, true);
  source.raw.message.body.attachments = [];
  delete source.raw.message.recipient.user_id;
  assert.equal((await shape(source)).attachments_empty, true);
  assert.equal((await shape(source)).recipient_keys_supported, true);
  source.raw.message.url = 'https://private-source.example/private-url';
  source.raw.message.stat = { views: 42 };
  source.raw.message.body.text = ' \nprivate-body\r\t';
  const metadata = await shape(source);
  assert.equal(metadata.original_metadata_keys_only, true);
  assert.equal(metadata.original_url_kind, 'string');
  assert.equal(metadata.original_stat_kind, 'object');
  assert.equal(metadata.content_matches, false);
  assert.equal(metadata.content_matches_ascii_trim, true);
  source.raw.message.link = { type: 'forward', message: { text: 'private-forward' } };
  const forwarded = await shape(source);
  assert.equal(forwarded.original_metadata_keys_only, false);
  assert.equal(forwarded.original_forward, true);
  assert.equal(forwarded.original_link_kind, 'object');
  assert.equal(forwarded.link_keys_supported, true);
  assert.equal(forwarded.linked_keys_supported, true);
  assert.equal(forwarded.linked_text_kind, 'string');
  source.raw.message.link.message.attachments = [{ type: 'image', url: 'private-attachment' }];
  const media = await shape(source);
  assert.equal(media.linked_attachments_kind, 'array');
  assert.equal(media.linked_attachments_empty, false);
  assert.equal(media.linked_media_shape_bounded, true);
  assert.equal(media.linked_images_only, true);
  assert.equal(media.linked_passive_media_only, true);
  source.raw.message.link.message.attachments = [{ type: 'private-unknown-type' }];
  assert.equal((await shape(source)).linked_passive_media_only, false);
  source.raw.message.link.message.attachments = Array.from({ length: 33 }, () => ({
    type: 'image',
  }));
  assert.equal((await shape(source)).linked_media_shape_bounded, false);
  assert.equal((await shape(source)).linked_images_only, null);
  source.raw.message['private-unknown-key'] = 'private-unknown-value';
  assert.equal((await shape(source)).original_keys_supported, false);
  source.message.text = 'private-'.repeat(40000);
  assert.equal((await shape(source)).budget_exceeded, true);
  await database.query('UPDATE webhook_events SET normalized_payload = $1::jsonb WHERE id = $2', [
    payload,
    candidateId,
  ]);
  for (const field of ['next_enqueue_at', 'timeout_quarantine_expires_at', 'processed_at']) {
    await database.exec(
      `UPDATE webhook_events SET ${field} = '2026-01-03' WHERE status = 'FAILED'`,
    );
    await report('ineligible_predecessor');
    await database.exec(`UPDATE webhook_events SET ${field} = NULL WHERE status = 'FAILED'`);
  }
  for (const error of [
    `${legacy}: private-suffix`,
    'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:CANONICAL_BUSINESS_ALREADY_STARTED; durable-effects recovery required',
    'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:private-token-error',
  ]) {
    await database.query("UPDATE webhook_events SET error_message = $1 WHERE status = 'FAILED'", [
      error,
    ]);
    await report('ineligible_predecessor');
  }
  await database.query("UPDATE webhook_events SET error_message = $1 WHERE status = 'FAILED'", [
    legacy,
  ]);
  // FLAG: A queued predecessor earlier than the eligible legacy row must remain the fence.
  await database.query(
    `INSERT INTO webhook_events(id, status, created_at, normalized_payload)
    VALUES ('private-unknown', 'QUEUED', '2025-12-31', $1::jsonb)`,
    [payload],
  );
  await report('ineligible_predecessor');
  await database.exec("DELETE FROM webhook_events WHERE id = 'private-unknown'");
  await database.query(
    "UPDATE webhook_events SET id = 'private-invalid <body>' WHERE status = 'FAILED'",
  );
  await report('ineligible_predecessor');
  await database.query("UPDATE webhook_events SET id = $1 WHERE status = 'FAILED'", [candidateId]);
  // Equal timestamp receipts must choose the first ID before message-shape filtering.
  await database.exec(`INSERT INTO webhook_events(id, status, created_at, normalized_payload)
    VALUES ('private-received-a', 'RECEIVED', '2026-01-02', '{"type":"bot_started","token":"private-token"}')`);
  await report('source_unknown');
  await database.exec("DELETE FROM webhook_events WHERE id = 'private-received-a'");
  await report('legacy_unverified_candidate', candidateId);
  await database.exec("DELETE FROM webhook_events WHERE status = 'FAILED'");
  await report('no_predecessor');
  await database.exec(`DROP INDEX webhook_events_status_created_at_id_idx;
    CREATE INDEX webhook_events_status_created_at_id_idx ON webhook_events(status, id, created_at)`);
  assert.equal(
    (await database.query(readiness)).rows[0].legacy_order_candidates_index_ready,
    'false',
  );
  await database.exec(`DROP INDEX webhook_events_status_created_at_id_idx;
    CREATE INDEX webhook_events_status_created_at_id_idx ON webhook_events(status, created_at, id)`);
  // FLAG: Same-name, valid three-key indexes with altered ordering/expression/predicate
  // must refuse admission; LIMIT 1 cannot protect a forced history sort or filtered scan.
  for (const tamperedIndexSql of [
    orderedIndexSql.replace('"created_at",\n  "id"', '"id",\n  "created_at"'),
    orderedIndexSql.replace('"created_at",', '"created_at" DESC,'),
    orderedIndexSql.replace("->'message'->>'chatId'", "->'message'->>'messageId'"),
    orderedIndexSql.replace(
      "ARRAY['message_created', 'message_edited']",
      "ARRAY['message_created']",
    ),
    orderedIndexSql.replace("'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:'", "'private-marker'"),
  ]) {
    assert.notEqual(tamperedIndexSql, orderedIndexSql);
    await database.exec('DROP INDEX webhook_events_ordered_chat_head_idx');
    await database.exec(tamperedIndexSql);
    assert.equal(
      (await database.query(readiness)).rows[0].legacy_order_candidates_index_ready,
      'false',
    );
  }
  await database.exec('DROP INDEX webhook_events_ordered_chat_head_idx');
  await database.exec(orderedIndexSql);
  assert.equal(
    (await database.query(readiness)).rows[0].legacy_order_candidates_index_ready,
    'true',
  );
});

test(
  'native legacy candidate probes use bounded indexes with 12000 retained and tied receipts',
  { skip: !nativePostgresUrl, timeout: 30_000 },
  async (t) => {
    const address = new URL(nativePostgresUrl);
    assert.ok(
      ['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) &&
        address.pathname.includes('race_test'),
      'Native candidate integration requires disposable local PostgreSQL race_test',
    );
    const data = fixture();
    t.after(() => rmSync(data.directory, { force: true, recursive: true }));
    assert.equal(runAudit(data, ['legacy-order-candidates']).status, 0);
    const sql = readFileSync(data.sql, 'utf8');
    const statement = extractLegacyOrderCandidatesSql(sql);
    const { default: pg } = await import('pg');
    const client = new pg.Client({
      connectionString: nativePostgresUrl,
      connectionTimeoutMillis: 5_000,
      query_timeout: 10_000,
      options: '-c timezone=UTC -c statement_timeout=2500 -c lock_timeout=250',
    });
    const namespace = `legacy_candidates_${randomUUID().replaceAll('-', '')}`;
    let connected = false;
    try {
      await client.connect();
      connected = true;
      const identity = await client.query('SELECT version() AS version');
      assert.match(identity.rows[0].version, /^PostgreSQL /u);
      assert.doesNotMatch(identity.rows[0].version, /pglite|wasm/iu);
      // FLAG: The large equal-time/history fixture and plan execute only in a rolled-back
      // disposable schema. No production rows, payloads, identities or role participate.
      await client.query(`BEGIN; CREATE SCHEMA ${namespace};
        SET LOCAL search_path = ${namespace}, pg_catalog;
        CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'QUEUED', 'FAILED');
        CREATE TABLE webhook_events (id text PRIMARY KEY, status "WebhookStatus", created_at timestamp,
          error_message text, next_enqueue_at timestamp, timeout_quarantine_expires_at timestamp,
          processed_at timestamp, normalized_payload jsonb DEFAULT '{}');
        CREATE INDEX webhook_events_status_created_at_id_idx ON webhook_events(status, created_at, id);`);
      await client.query(
        readFileSync(
          resolve(
            root,
            'apps/api/prisma/migrations/20260815123000_add_webhook_ordered_chat_head_index/migration.sql',
          ),
          'utf8',
        ).replace('CREATE INDEX CONCURRENTLY', 'CREATE INDEX'),
      );
      const readiness = extractLegacyOrderCandidatesReadinessSql(sql).replaceAll(
        "'public.webhook_events",
        `'${namespace}.webhook_events`,
      );
      assert.equal(
        (await client.query(readiness)).rows[0].legacy_order_candidates_index_ready,
        'true',
      );
      await client.query(`INSERT INTO webhook_events(id, status, created_at, error_message, normalized_payload)
        SELECT 'private-history-' || ordinal, 'FAILED', '2025-01-01', 'private-terminal-error', '{}'
        FROM generate_series(1, 6000) ordinal;
        INSERT INTO webhook_events(id, status, created_at, normalized_payload)
        SELECT 'private-received-' || lpad(ordinal::text, 6, '0'), 'RECEIVED', '2026-01-02',
          '{"type":"message_created","message":{"chatId":"private-chat","text":"private-body"}}'
        FROM generate_series(1, 6000) ordinal;
        INSERT INTO webhook_events(id, status, created_at, error_message, normalized_payload)
        VALUES ('c1111111111111111111111111', 'FAILED', '2026-01-01',
          'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required',
          '{"type":"message_created","message":{"chatId":"private-chat","text":"private-body"}}');
        SET LOCAL enable_seqscan=off; SET LOCAL enable_bitmapscan=off;
        SET LOCAL max_parallel_workers_per_gather=0; SET LOCAL jit=off; ANALYZE webhook_events;`);
      const plan = await client.query(`EXPLAIN (FORMAT JSON) ${statement}`);
      const relationScans = [];
      const sorts = [];
      const collect = (node) => {
        if (node['Relation Name'] === 'webhook_events') relationScans.push(node);
        if (['Sort', 'Incremental Sort'].includes(node['Node Type'])) sorts.push(node);
        for (const child of node.Plans ?? []) collect(child);
      };
      collect(plan.rows[0]['QUERY PLAN'][0].Plan);
      assert.equal(relationScans.length, 2);
      assert.equal(sorts.length, 0, 'Equal-time receipts must not amplify a LIMIT 1 sort');
      assert.ok(
        relationScans.every((node) =>
          ['Index Scan', 'Index Only Scan'].includes(node['Node Type']),
        ),
      );
      assert.ok(
        relationScans.every((node) => node.Filter === undefined),
        'Source probes must not filter through retained rows behind LIMIT 1',
      );
      assert.deepEqual(relationScans.map((node) => node['Index Name']).sort(), [
        'webhook_events_ordered_chat_head_idx',
        'webhook_events_status_created_at_id_idx',
      ]);
      const result = JSON.parse(Object.values((await client.query(statement)).rows[0])[0]);
      assert.equal(result.candidate_count, 1);
      assert.equal(result.candidate_receipt_id, 'c1111111111111111111111111');
      assert.doesNotMatch(JSON.stringify(result), /private-|LEGACY_EXECUTION|message_created/u);
      assert.equal(runAudit(data, ['legacy-order-window']).status, 0);
      const windowSql = readFileSync(data.sql, 'utf8');
      const windowStatement = windowSql.slice(
        windowSql.indexOf('WITH receipt_window AS MATERIALIZED'),
        windowSql.indexOf('\n\\else', windowSql.indexOf('WITH receipt_window AS MATERIALIZED')),
      );
      const windowPlan = await client.query(`EXPLAIN (FORMAT JSON) ${windowStatement}`);
      relationScans.length = 0;
      collect(windowPlan.rows[0]['QUERY PLAN'][0].Plan);
      assert.equal(relationScans.length, 2);
      assert.ok(
        relationScans.every(
          (node) =>
            ['Index Scan', 'Index Only Scan'].includes(node['Node Type']) &&
            node.Filter === undefined,
        ),
      );
      let windowReport = JSON.parse(
        Object.values((await client.query(windowStatement)).rows[0])[0],
      );
      assert.equal(windowReport.sampled_receipts, 128);
      assert.equal(windowReport.receipts_truncated, true);
      assert.deepEqual(windowReport.candidates, [
        {
          classification: 'legacy_unverified_candidate',
          candidate_receipt_id: 'c1111111111111111111111111',
        },
      ]);
      await client.query(`INSERT INTO webhook_events(id,status,created_at,error_message,normalized_payload) VALUES
        ('unknown-earlier','FAILED','2025-12-01','WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:UNKNOWN', '{"type":"message_created","message":{"chatId":"private-second"}}'),
        ('must-not-skip-to','FAILED','2025-12-02','WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required', '{"type":"message_created","message":{"chatId":"private-second"}}'),
        ('second-received','RECEIVED','2026-01-01',NULL,'{"type":"message_created","message":{"chatId":"private-second"}}')`);
      windowReport = JSON.parse(Object.values((await client.query(windowStatement)).rows[0])[0]);
      assert.deepEqual(windowReport.candidates, [
        { classification: 'ineligible_predecessor', candidate_receipt_id: null },
        {
          classification: 'legacy_unverified_candidate',
          candidate_receipt_id: 'c1111111111111111111111111',
        },
      ]);
      assert.doesNotMatch(JSON.stringify(windowReport), /private-|must-not-skip|unknown-earlier/u);
      await client.query(`DROP INDEX webhook_events_ordered_chat_head_idx;
        CREATE INDEX webhook_events_ordered_chat_head_idx
        ON webhook_events ((normalized_payload->>'chatId'), created_at, id)`);
      assert.equal(
        (await client.query(readiness)).rows[0].legacy_order_candidates_index_ready,
        'false',
      );
    } finally {
      if (connected) await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  },
);

test(
  'native queue quarantine predecessor diagnostics stay bounded and private',
  { skip: !nativePostgresUrl, timeout: 30_000 },
  async (t) => {
    const address = new URL(nativePostgresUrl);
    assert.ok(
      ['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) &&
        address.pathname.includes('race_test'),
      'Native queue integration requires disposable local PostgreSQL race_test',
    );
    const data = fixture();
    t.after(() => rmSync(data.directory, { force: true, recursive: true }));
    const emitted = runAudit(data, ['queue']);
    assert.equal(emitted.status, 0, emitted.stderr);
    const statement = extractQueueReportSql(readFileSync(data.sql, 'utf8'));
    assert.equal([...statement.matchAll(/FROM webhook_events\b/gu)].length, 3);
    assert.equal([...statement.matchAll(/\bLIMIT 2001\b/gu)].length, 1);
    assert.equal([...statement.matchAll(/\bLIMIT 1\b/gu)].length, 2);
    assert.doesNotMatch(statement, /webhook_execution_claims|moderation_delete_intents/u);
    const { default: pg } = await import('pg');
    const client = new pg.Client({
      connectionString: nativePostgresUrl,
      connectionTimeoutMillis: 5_000,
      query_timeout: 10_000,
      options: '-c timezone=UTC -c statement_timeout=2500 -c lock_timeout=250',
    });
    const namespace = `queue_quarantine_${randomUUID().replaceAll('-', '')}`;
    const nonce = '11111111-2222-4333-8444-555555555555';
    const legacy =
      'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required';
    const started =
      'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:CANONICAL_BUSINESS_ALREADY_STARTED; durable-effects recovery required';
    const watchdog = `WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:${nonce}: Webhook user-facing hot path timed out after 10000ms for message_created`;
    const payload = JSON.stringify({
      type: 'message_created',
      message: { chatId: 'private-chat', messageId: 'private-message', text: 'private-payload' },
    });
    let connected = false;
    try {
      await client.connect();
      connected = true;
      const identity = await client.query('SELECT version() AS version');
      assert.match(identity.rows[0].version, /^PostgreSQL /u);
      assert.doesNotMatch(identity.rows[0].version, /pglite|wasm/iu);
      // FLAG: Execute the emitted fixed report in one rolled-back disposable schema;
      // no production role, table, index, payload or query text participates in this fixture.
      await client.query(`
        BEGIN;
        CREATE SCHEMA ${namespace};
        SET LOCAL search_path = ${namespace}, pg_catalog;
        CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'QUEUED', 'FAILED');
        CREATE TABLE webhook_events (
          id text PRIMARY KEY, status "WebhookStatus", created_at timestamp,
          enqueue_attempts integer DEFAULT 1, next_enqueue_at timestamp,
          error_message text, timeout_quarantine_expires_at timestamp,
          normalized_payload jsonb DEFAULT '{}'
        );
        CREATE INDEX webhook_events_status_created_at_idx ON webhook_events(status, created_at);
      `);
      await client.query(
        readFileSync(
          resolve(
            root,
            'apps/api/prisma/migrations/20260815123000_add_webhook_ordered_chat_head_index/migration.sql',
          ),
          'utf8',
        ).replace('CREATE INDEX CONCURRENTLY', 'CREATE INDEX'),
      );
      // Equal predecessor times exercise runtime's (created_at, id) ordering;
      // heap insertion order and a later receipt must not select the second predecessor.
      await client.query(
        `INSERT INTO webhook_events(id, status, created_at, error_message, normalized_payload)
         VALUES ('private-predecessor-z', 'FAILED', clock_timestamp() - interval '2 minutes', $1, $3),
           ('private-predecessor-a', 'FAILED', clock_timestamp() - interval '2 minutes', $2, $3),
           ('private-received', 'RECEIVED', clock_timestamp() - interval '1 minute', NULL, $3)`,
        [started, legacy, payload],
      );
      await client.query(`
        UPDATE webhook_events SET created_at =
          (SELECT created_at FROM webhook_events WHERE id = 'private-predecessor-z')
        WHERE id = 'private-predecessor-a';
      `);
      const report = async () => {
        const { rows } = await client.query(statement);
        const value = JSON.parse(Object.values(rows[0])[0]);
        assert.doesNotMatch(
          JSON.stringify(value),
          /private-|11111111|LEGACY_EXECUTION|CANONICAL_BUSINESS|Webhook user-facing/u,
        );
        return value.rows.find((row) => row.status === 'RECEIVED').oldest_ordering_predecessor;
      };
      const initial = await report();
      assert.equal(initial.quarantine_subtype, 'legacy_execution_unverified');
      assert.equal(initial.quarantine_deadline_present, false);
      assert.equal(initial.quarantine_deadline_expired, null);
      assert.equal(initial.quarantine_deadline_in_seconds, null);
      assert.equal(initial.quarantine_deadline_overdue_seconds, null);
      assert.equal(initial.source_marker, 'missing');
      assert.equal(initial.raw_source_present, false);
      assert.equal(initial.direct_update_timestamp_shape, 'shape_unknown');
      assert.equal(initial.direct_update_receipt_delta_seconds, null);
      assert.equal(initial.direct_message_shape, 'shape_unknown');
      assert.equal(initial.direct_message_timestamp_shape, 'shape_unknown');
      assert.equal(initial.direct_message_receipt_delta_seconds, null);
      for (const [error, subtype] of [
        [started, 'canonical_business_started'],
        [watchdog, 'detached_timeout'],
        [`${watchdog} | stage=private-stage`, 'detached_timeout'],
        [
          `${watchdog}; initial timeout quarantine persistence failed: private-error`,
          'detached_timeout',
        ],
        [
          `WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:${nonce}: detached execution completed without a canonical claim: private-error`,
          'unclaimed_detached_completed',
        ],
        [
          `WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:${nonce}: detached execution failed without a canonical claim: private-error`,
          'unclaimed_detached_failed',
        ],
        [`${legacy}: private-suffix`, 'other_pending'],
        [`${started}: private-suffix`, 'other_pending'],
        [
          `WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:${nonce}: private-content: LEGACY_EXECUTION_UNVERIFIED; exact effects proof required`,
          'other_pending',
        ],
        [
          'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:private-nonce: Webhook user-facing hot path timed out after 10000ms for message_created',
          'other_pending',
        ],
        [`${watchdog}private-suffix`, 'other_pending'],
        [`private-prefix: ${legacy}`, null],
        [`Webhook preparation failed: ${started}`, null],
      ]) {
        await client.query(
          `UPDATE webhook_events SET error_message = $1,
             next_enqueue_at = clock_timestamp() - interval '1 second'
           WHERE id = 'private-predecessor-a'`,
          [error],
        );
        assert.equal((await report()).quarantine_subtype, subtype);
      }
      const receiptMs = Date.now() - 120_000;
      await client.query(
        `UPDATE webhook_events SET created_at = to_timestamp($1 / 1000.0) AT TIME ZONE 'UTC'
         WHERE id IN ('private-predecessor-a', 'private-predecessor-z')`,
        [receiptMs],
      );
      const numericCases = [
        [receiptMs - 90_000, 'numeric_milliseconds', -90],
        [(receiptMs - 90_000) / 1000, 'numeric_seconds', -90],
        [receiptMs + 1234.9, 'numeric_milliseconds', 1.234],
        [10_000_000_000, 'numeric_milliseconds', (10_000_000_000 - receiptMs) / 1000],
        [8_640_000_000_000_000, 'numeric_milliseconds', (8_640_000_000_000_000 - receiptMs) / 1000],
        [8_640_000_000_000_001, 'invalid_numeric', null],
        [1e308, 'invalid_numeric', null],
        [-1e308, 'invalid_numeric', null],
        [0, 'invalid_numeric', null],
        [-1, 'invalid_numeric', null],
        [0.0001, 'invalid_numeric', null],
        [null, 'missing', null],
        [String(receiptMs), 'shape_unknown', null],
        [new Date(receiptMs).toISOString(), 'shape_unknown', null],
        ['2026-99-99T00:00:00Z', 'shape_unknown', null],
        [true, 'shape_unknown', null],
        [{ private: 'private-value' }, 'shape_unknown', null],
        [[receiptMs], 'shape_unknown', null],
      ];
      for (const [timestamp, shape, delta] of numericCases) {
        await client.query(
          `UPDATE webhook_events SET normalized_payload = $1::jsonb
           WHERE id = 'private-predecessor-a'`,
          [
            JSON.stringify({
              ...JSON.parse(payload),
              eventTimestampSource: 'payload',
              raw: { timestamp, message: { timestamp, text: 'private-raw-message' } },
            }),
          ],
        );
        const value = await report();
        assert.equal(value.source_marker, 'payload');
        assert.equal(value.raw_source_present, true);
        assert.equal(value.direct_update_timestamp_shape, shape);
        assert.equal(value.direct_update_receipt_delta_seconds, delta);
        assert.equal(value.direct_message_shape, 'object');
        assert.equal(value.direct_message_timestamp_shape, shape);
        assert.equal(value.direct_message_receipt_delta_seconds, delta);
      }
      for (const [fields, marker, rawPresent, updateShape, messageShape, messageTimeShape] of [
        [
          { eventTimestampSource: ' PAYLOAD ', timestamp: receiptMs },
          'payload',
          false,
          'numeric_milliseconds',
          'object',
          'missing',
        ],
        [
          { eventTimestampSource: 'ingress', timestamp: receiptMs },
          'ingress',
          false,
          'shape_unknown',
          'shape_unknown',
          'shape_unknown',
        ],
        [
          { eventTimestampSource: 'private-source', raw: {} },
          'other',
          true,
          'missing',
          'missing',
          'missing',
        ],
        [{ eventTimestampSource: null, raw: {} }, 'missing', true, 'missing', 'missing', 'missing'],
        [
          { eventTimestampSource: { private: 'private-marker' } },
          'other',
          false,
          'shape_unknown',
          'shape_unknown',
          'shape_unknown',
        ],
        [{ raw: [] }, 'missing', false, 'shape_unknown', 'shape_unknown', 'shape_unknown'],
        [{ raw: null }, 'missing', false, 'shape_unknown', 'shape_unknown', 'shape_unknown'],
        [
          { raw: { createdAt: new Date(receiptMs).toISOString() } },
          'missing',
          true,
          'shape_unknown',
          'missing',
          'missing',
        ],
        [
          { raw: { data: { timestamp: receiptMs, message: { timestamp: receiptMs } } } },
          'missing',
          true,
          'shape_unknown',
          'shape_unknown',
          'shape_unknown',
        ],
        [{ raw: { message: true } }, 'missing', true, 'missing', 'shape_unknown', 'shape_unknown'],
        [
          { raw: { message: { created_at: receiptMs } } },
          'missing',
          true,
          'missing',
          'object',
          'shape_unknown',
        ],
      ]) {
        await client.query(
          `UPDATE webhook_events SET normalized_payload = $1::jsonb
           WHERE id = 'private-predecessor-a'`,
          [JSON.stringify({ ...JSON.parse(payload), ...fields })],
        );
        const value = await report();
        assert.equal(value.source_marker, marker);
        assert.equal(value.raw_source_present, rawPresent);
        assert.equal(value.direct_update_timestamp_shape, updateShape);
        assert.equal(value.direct_message_shape, messageShape);
        assert.equal(value.direct_message_timestamp_shape, messageTimeShape);
      }
      for (const [delay, expired] of [
        [60, false],
        [-60, true],
      ]) {
        await client.query(
          `UPDATE webhook_events SET error_message = $1,
             timeout_quarantine_expires_at = (clock_timestamp() AT TIME ZONE 'UTC') + $2 * interval '1 second'
           WHERE id = 'private-predecessor-a'`,
          [legacy, delay],
        );
        const value = await report();
        assert.equal(value.quarantine_deadline_present, true);
        assert.equal(value.quarantine_deadline_expired, expired);
        if (expired) {
          assert.equal(value.quarantine_deadline_in_seconds, 0);
          assert.ok(value.quarantine_deadline_overdue_seconds >= 60);
        } else {
          assert.ok(
            value.quarantine_deadline_in_seconds > 0 && value.quarantine_deadline_in_seconds <= 60,
          );
          assert.equal(value.quarantine_deadline_overdue_seconds, 0);
        }
      }
      await client.query(`
        INSERT INTO webhook_events(id, status, created_at, error_message)
        SELECT 'private-history-' || ordinal, 'FAILED',
          clock_timestamp() - interval '1 day', 'private-terminal-error'
        FROM generate_series(1, 2100) ordinal;
        SET LOCAL enable_seqscan=off;
        SET LOCAL enable_bitmapscan=off;
        SET LOCAL max_parallel_workers_per_gather=0;
        SET LOCAL jit=off;
        ANALYZE webhook_events;
      `);
      const plans = await client.query(`EXPLAIN (FORMAT JSON) ${statement}`);
      const relationScans = [];
      const collect = (node) => {
        if (node['Relation Name'] === 'webhook_events') relationScans.push(node);
        for (const child of node.Plans ?? []) collect(child);
      };
      collect(plans.rows[0]['QUERY PLAN'][0].Plan);
      assert.equal(relationScans.length, 3);
      assert.ok(
        relationScans.every((node) =>
          ['Index Scan', 'Index Only Scan'].includes(node['Node Type']),
        ),
      );
      assert.deepEqual([...new Set(relationScans.map((node) => node['Index Name']))].sort(), [
        'webhook_events_ordered_chat_head_idx',
        'webhook_events_status_created_at_idx',
      ]);
      assert.equal((await report()).quarantine_subtype, 'legacy_execution_unverified');
    } finally {
      if (connected) await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  },
);

test('queue oldest-state diagnostics remain bounded and never emit raw errors', async (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  const result = runAudit(data, ['queue']);
  assert.equal(result.status, 0, result.stderr);
  const sql = readFileSync(data.sql, 'utf8');
  const start = sql.indexOf('WITH queue_statuses(status) AS');
  const end = sql.indexOf(') predecessor ON TRUE;', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const statement = sql.slice(start, end + ') predecessor ON TRUE;'.length);
  assert.equal([...statement.matchAll(/FROM webhook_events\b/gu)].length, 3);
  assert.equal([...statement.matchAll(/\bLIMIT 2001\b/gu)].length, 1);
  assert.equal([...statement.matchAll(/\bLIMIT 1\b/gu)].length, 2);
  assert.doesNotMatch(statement, /webhook_execution_claims|moderation_delete_intents/u);
  const database = new PGlite();
  t.after(() => database.close());
  await database.exec(`
    CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'QUEUED', 'FAILED');
    CREATE TABLE webhook_events (
      status "WebhookStatus", created_at timestamptz, enqueue_attempts integer,
      next_enqueue_at timestamptz, error_message text, timeout_quarantine_expires_at timestamptz,
      id text DEFAULT 'fixture', normalized_payload jsonb DEFAULT '{}'
    );
    CREATE INDEX webhook_events_status_created_at_idx ON webhook_events(status, created_at);
    INSERT INTO webhook_events(status, created_at, enqueue_attempts, next_enqueue_at, error_message) VALUES
      ('RECEIVED', now() - interval '5 minutes', 0, now() + interval '1 minute',
       'Webhook preparation deferred: canonical webhook preparation is still pending'),
      ('RECEIVED', now(), 0, NULL, 'private-secret-error');
  `);
  const { rows } = await database.query(statement);
  const report = JSON.parse(Object.values(rows[0])[0]);
  const received = report.rows.find((row) => row.status === 'RECEIVED');
  assert.equal(received.count_lower_bound, 2);
  assert.equal(received.oldest_preparation_state, 'canonical_pending');
  assert.equal(received.oldest_enqueue_attempts, 0);
  assert.ok(received.oldest_retry_in_seconds > 0 && received.oldest_retry_in_seconds <= 60);
  assert.equal(report.rows.find((row) => row.status === 'QUEUED').oldest_preparation_state, null);
  assert.doesNotMatch(JSON.stringify(report), /private-secret-error|Webhook preparation deferred/u);
  for (const [message, expected] of [
    ['Webhook preparation capacity unavailable', 'preparation_capacity'],
    ['Webhook preparation capacity unavailable: private-suffix', 'preparation_deferred'],
    ['Required owner probe is pending: private-identity', 'preparation_deferred'],
  ]) {
    await database.query('UPDATE webhook_events SET error_message = $1', [
      `Webhook preparation deferred: ${message}`,
    ]);
    const classified = await database.query(statement);
    const classifiedReport = JSON.parse(Object.values(classified.rows[0])[0]);
    assert.equal(
      classifiedReport.rows.find((row) => row.status === 'RECEIVED').oldest_preparation_state,
      expected,
    );
    assert.doesNotMatch(JSON.stringify(classifiedReport), /private-|capacity unavailable/u);
  }
  await database.query(`UPDATE webhook_events SET normalized_payload = $1`, [
    JSON.stringify({
      type: 'message_created',
      message: { chatId: 'private-chat' },
    }),
  ]);
  await database.query(
    `INSERT INTO webhook_events(status, created_at, error_message, normalized_payload)
     VALUES ('FAILED', now() - interval '10 minutes', $1, $2)`,
    [
      'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:private-nonce',
      JSON.stringify({
        type: 'message_created',
        message: { chatId: 'private-chat' },
      }),
    ],
  );
  const fencedResult = await database.query(statement);
  const fencedReport = JSON.parse(Object.values(fencedResult.rows[0])[0]);
  assert.equal(
    fencedReport.rows.find((row) => row.status === 'RECEIVED').oldest_ordering_fence,
    'timeout_quarantined',
  );
  assert.doesNotMatch(JSON.stringify(fencedReport), /private-chat|private-nonce/u);
  await database.exec(`
    UPDATE webhook_events SET enqueue_attempts = 17,
      next_enqueue_at = now() - interval '30 seconds',
      error_message = 'Webhook preparation failed: private-secret-error'
    WHERE status = 'FAILED';
  `);
  const retryResult = await database.query(statement);
  const retryReport = JSON.parse(Object.values(retryResult.rows[0])[0]);
  const predecessor = retryReport.rows.find(
    (row) => row.status === 'RECEIVED',
  ).oldest_ordering_predecessor;
  assert.equal(predecessor.enqueue_attempts, 17);
  assert.equal(predecessor.error_kind, 'preparation_failed');
  assert.equal(predecessor.error_family, 'other');
  assert.equal(predecessor.error_truncated, false);
  assert.equal(predecessor.retry_in_seconds, 0);
  assert.ok(predecessor.retry_overdue_seconds >= 30);
  assert.ok(predecessor.age_seconds >= 600);
  assert.equal(
    retryReport.rows.find((row) => row.status === 'QUEUED').oldest_ordering_predecessor,
    null,
  );
  assert.doesNotMatch(JSON.stringify(retryReport), /private-chat|private-secret-error|fixture/u);
  await database.query("UPDATE webhook_events SET error_message = $1 WHERE status = 'FAILED'", [
    'Webhook preparation deferred: Webhook preparation capacity unavailable',
  ]);
  const capacityResult = await database.query(statement);
  const capacityReport = JSON.parse(Object.values(capacityResult.rows[0])[0]);
  assert.equal(
    capacityReport.rows.find((row) => row.status === 'RECEIVED').oldest_ordering_predecessor
      .error_kind,
    'preparation_capacity',
  );
  assert.doesNotMatch(JSON.stringify(capacityReport), /private-|capacity unavailable/u);
  for (const [error, family] of [
    ['Foreign key constraint violated: private-identity', 'foreign_key'],
    ['Webhook preparation lease was lost before READY for private-event', 'preparation_lease_lost'],
    ['Request failed with status code 400: private-payload', 'http_400'],
    ['Invalid prisma.privateModel.create invocation: private-data', 'prisma_invocation'],
    ['Cannot read properties of undefined: private-field', 'invalid_object_state'],
  ]) {
    await database.query("UPDATE webhook_events SET error_message = $1 WHERE status = 'FAILED'", [
      `Webhook preparation failed: ${error}`,
    ]);
    const classified = await database.query(statement);
    const classifiedReport = JSON.parse(Object.values(classified.rows[0])[0]);
    assert.equal(
      classifiedReport.rows.find((row) => row.status === 'RECEIVED').oldest_ordering_predecessor
        .error_family,
      family,
    );
    assert.doesNotMatch(JSON.stringify(classifiedReport), /private-/u);
  }
  // FLAG: Embedded copies of source-defined error literals remain unclassified.
  // Even an anchored label describes a saved error and never grants recovery authority.
  for (const [error, family] of [
    ['Canonical webhook claim is not ready for private-event', 'canonical_not_ready'],
    ['Canonical webhook business lease is busy for private-event', 'canonical_business_lease_busy'],
    [
      'Canonical webhook business lease was lost before completion for private-event',
      'canonical_business_lease_lost',
    ],
    [
      'Canonical webhook business lease was lost before unfenced timeout settlement for private-event',
      'canonical_business_lease_lost',
    ],
    [
      'Canonical webhook business lease was lost during timeout quarantine for private-event',
      'canonical_business_lease_lost',
    ],
    [
      'Canonical webhook business lease storage is unavailable for private-event',
      'canonical_business_lease_unavailable',
    ],
    [
      'Chat rules publication is in flight; retry own-bot message classification',
      'rules_publication_fence',
    ],
    ['No eligible moderation executor', 'no_eligible_executor'],
    ['Moderation job already exists but cannot be loaded', 'job_missing'],
    ['Moderation job exists in unsupported state: waiting-children', 'job_state_unsupported'],
  ]) {
    for (const prefix of ['', 'Webhook preparation failed: ']) {
      await database.query("UPDATE webhook_events SET error_message = $1 WHERE status = 'FAILED'", [
        `${prefix}${error}`,
      ]);
      const classified = await database.query(statement);
      const classifiedReport = JSON.parse(Object.values(classified.rows[0])[0]);
      assert.equal(
        classifiedReport.rows.find((row) => row.status === 'RECEIVED').oldest_ordering_predecessor
          .error_family,
        family,
      );
      assert.doesNotMatch(
        JSON.stringify(classifiedReport),
        /private-|Canonical webhook|Chat rules publication|waiting-children/u,
      );
    }
  }
  for (const error of [
    'Private content: Canonical webhook claim is not ready for private-event',
    'Webhook preparation failed: Private content: Canonical webhook business lease is busy for private-event',
    'Private content: Canonical webhook business lease was lost before completion for private-event',
    'Private content: Canonical webhook business lease storage is unavailable for private-event',
    'Private content: Chat rules publication is in flight; retry own-bot message classification',
    'Chat rules publication is in flight; retry own-bot message classification: private-suffix',
    'Canonical webhook claim is not ready for ',
    'Canonical webhook business lease is busy for ',
    'Canonical webhook business lease was lost before completion for ',
    'Canonical webhook business lease storage is unavailable for ',
    'Moderation job exists in unsupported state: ',
    'No eligible moderation executor: private-payload',
    'Moderation job already exists but cannot be loaded: private-payload',
    'Private content: Moderation job exists in unsupported state: waiting-children',
  ]) {
    await database.query("UPDATE webhook_events SET error_message = $1 WHERE status = 'FAILED'", [
      error,
    ]);
    const classified = await database.query(statement);
    const classifiedReport = JSON.parse(Object.values(classified.rows[0])[0]);
    assert.equal(
      classifiedReport.rows.find((row) => row.status === 'RECEIVED').oldest_ordering_predecessor
        .error_family,
      'other',
    );
    assert.doesNotMatch(JSON.stringify(classifiedReport), /private-|Private content/u);
  }
  const typed = await database.query(statement);
  const typedReport = JSON.parse(Object.values(typed.rows[0])[0]);
  assert.equal(
    typedReport.rows.find((row) => row.status === 'RECEIVED').oldest_ordering_predecessor
      .event_type,
    'message_created',
  );
  await database.query(
    "UPDATE webhook_events SET normalized_payload = $1 WHERE status = 'FAILED'",
    [
      JSON.stringify({
        update_type: ' MESSAGE_EDITED ',
        chatId: 'private-chat',
      }),
    ],
  );
  const edited = await database.query(statement);
  const editedReport = JSON.parse(Object.values(edited.rows[0])[0]);
  assert.equal(
    editedReport.rows.find((row) => row.status === 'RECEIVED').oldest_ordering_predecessor
      .event_type,
    'message_edited',
  );
  assert.doesNotMatch(JSON.stringify(editedReport), /private-|MESSAGE_EDITED/u);
  await database.query("UPDATE webhook_events SET error_message = $1 WHERE status = 'FAILED'", [
    'Webhook preparation failed: Invalid prisma.chat.upsert() invocation in /app/apps/api/dist/apps/api/src/webhook/webhook.service.js:1915:72\nprivate-data',
  ]);
  const located = await database.query(statement);
  const locatedReport = JSON.parse(Object.values(located.rows[0])[0]);
  assert.equal(
    locatedReport.rows.find((row) => row.status === 'RECEIVED').oldest_ordering_predecessor
      .webhook_service_line,
    1915,
  );
  assert.doesNotMatch(JSON.stringify(locatedReport), /private-|\/app\/|upsert/u);
  await database.exec('SET enable_seqscan = off');
  const { rows: plans } = await database.query(
    `EXPLAIN (FORMAT JSON) SELECT enqueue_attempts, next_enqueue_at, error_message
     FROM webhook_events WHERE status = 'RECEIVED' ORDER BY created_at ASC LIMIT 1`,
  );
  assert.match(JSON.stringify(plans), /webhook_events_status_created_at_idx/u);
  await database.exec(
    readFileSync(
      resolve(
        root,
        'apps/api/prisma/migrations/20260815123000_add_webhook_ordered_chat_head_index/migration.sql',
      ),
      'utf8',
    ).replace('CREATE INDEX CONCURRENTLY', 'CREATE INDEX'),
  );
  const predecessorPlan = await database.query(`EXPLAIN (FORMAT JSON) ${statement}`);
  assert.match(JSON.stringify(predecessorPlan.rows), /webhook_events_ordered_chat_head_idx/u);
  const relationScans = [];
  const collectRelationScans = (node) => {
    if (node['Relation Name'] === 'webhook_events') relationScans.push(node);
    for (const child of node.Plans ?? []) collectRelationScans(child);
  };
  collectRelationScans(predecessorPlan.rows[0]['QUERY PLAN'][0].Plan);
  assert.equal(relationScans.length, 3);
  assert.ok(
    relationScans.every((node) => ['Index Scan', 'Index Only Scan'].includes(node['Node Type'])),
  );
  assert.deepEqual([...new Set(relationScans.map((node) => node['Index Name']))].sort(), [
    'webhook_events_ordered_chat_head_idx',
    'webhook_events_status_created_at_idx',
  ]);
});

test('monitor signal audit bounds both indexed source samples before aggregation', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));

  const result = runAudit(data, ['monitor-signals', '30']);
  assert.equal(result.status, 0, result.stderr);
  const sql = readFileSync(data.sql, 'utf8');
  assert.match(sql, /webhook_events_status_created_at_idx/u);
  assert.match(sql, /moderation_events_created_at_idx/u);
  assert.match(sql, /recent_webhooks AS MATERIALIZED/u);
  assert.match(sql, /moderation_sample AS MATERIALIZED/u);
  assert.match(sql, /bounded_moderation AS MATERIALIZED/u);
  assert.equal([...sql.matchAll(/>= statement_timestamp\(\) - make_interval/gu)].length, 2);
  assert.equal([...sql.matchAll(/LIMIT 2001/gu)].length, 2);
  assert.match(sql, /LIMIT 2000/u);
  assert.doesNotMatch(
    sql.slice(sql.indexOf('WITH webhook_statuses(status) AS')),
    /raw_payload|normalized_payload|error_message|source_ip|user_id|masked_excerpt/u,
  );
});

test('Publisher access census stays opt-in, bounded and uses the guarded audit session', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  const result = runAudit(data, ['publisher-access-census', '--explain']);
  assert.equal(result.status, 0, result.stderr);
  const sql = readFileSync(data.sql, 'utf8');
  assert.match(sql, /publisher_access_census_ready/u);
  assert.match(sql, /EXPLAIN \(FORMAT JSON\) WITH source AS MATERIALIZED/u);
  assert.match(sql, /ORDER BY chat_id LIMIT 50001/u);
  assert.doesNotMatch(sql, /EXPLAIN ANALYZE|capabilities|permissions_snapshot/u);
  assert.equal(
    runConnect(data, ['postgres-audit', 'publisher-access-census', '--explain']).status,
    0,
  );
  for (const args of [
    ['publisher-access-census', 'private-id'],
    ['publisher-access-census', '--apply'],
  ]) {
    assert.notEqual(runAudit(data, args).status, 0);
    assert.notEqual(runConnect(data, ['postgres-audit', ...args]).status, 0);
  }
  assert.equal(runAudit(data, ['all']).status, 0);
  assert.doesNotMatch(readFileSync(data.sql, 'utf8'), /publisher_access_census_ready/u);
});

test('Publisher publication audit uses only fixed bounded SQL and an optional plain EXPLAIN', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  const result = runAudit(data, ['publisher-publications', '--explain']);
  assert.equal(result.status, 0, result.stderr);
  const sql = readFileSync(data.sql, 'utf8');
  assert.match(sql, /publisher_publication_audit_ready/u);
  assert.match(sql, /publisher_publication_indexes_ready/u);
  assert.match(sql, /EXPLAIN \(FORMAT JSON\) WITH statuses/u);
  assert.doesNotMatch(sql, /EXPLAIN ANALYZE|raw_payload|publisher_dialog_context/u);
  for (const args of [
    ['publisher-publications', 'private-id'],
    ['publisher-publications', '--explain', 'extra'],
  ]) {
    assert.notEqual(runAudit(data, args).status, 0);
    assert.notEqual(
      spawnSync('bash', [connect, 'postgres-audit', ...args], {
        cwd: root,
        env: baseEnv(data),
        encoding: 'utf8',
      }).status,
      0,
    );
  }
  assert.equal(
    spawnSync('bash', [connect, 'postgres-audit', 'publisher-publications', '--explain'], {
      cwd: root,
      env: baseEnv(data),
      encoding: 'utf8',
    }).status,
    0,
  );
});

test('duplicate audit uses fixed windows and bounds every source before aggregation', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));

  const result = runAudit(data, ['duplicate']);
  assert.equal(result.status, 0, result.stderr);
  const sql = readFileSync(data.sql, 'utf8');

  assert.match(sql, /required_duplicate_indexes/u);
  for (const indexName of [
    'chat_settings_pkey',
    'moderation_events_created_at_idx',
    'moderation_delete_intents_retention_idx',
    'moderation_delete_intent_reasons_intent_reason_key',
  ]) {
    assert.match(sql, new RegExp(`'${indexName}'`, 'u'));
  }
  assert.match(sql, /index_definition\.indrelid/u);
  assert.match(sql, /indisvalid/u);
  assert.match(sql, /indisready/u);
  assert.match(sql, /indislive/u);
  assert.match(sql, /index_definition\.indpred IS NULL/u);
  assert.match(sql, /0 = ALL\(index_definition\.indoption\)/u);
  assert.match(sql, /pg_get_indexdef/u);

  assert.match(sql, /settings_sample_plus AS MATERIALIZED/u);
  assert.match(sql, /FROM chat_settings\s+ORDER BY id ASC\s+LIMIT 5001/u);
  assert.match(sql, /settings_sample AS MATERIALIZED[\s\S]*LIMIT 5000/u);
  assert.match(sql, /valid_named_timezones AS MATERIALIZED/u);
  assert.equal([...sql.matchAll(/FROM pg_timezone_names/gu)].length, 1);
  assert.match(sql, /name = lower\(btrim\(duplicate_timezone\)\)/u);
  assert.match(sql, /'audit', 'duplicate_settings'/u);
  assert.match(sql, /'schema_version', 2/u);
  assert.match(sql, /'saved_eligibility'/u);
  assert.match(sql, /'image_eligible_count_lower_bound'/u);
  assert.match(sql, /'legacy_compatibility'/u);
  assert.match(sql, /'controls_current_image_policy', false/u);
  assert.match(sql, /'runtime_authority', 'not_observed_by_sql'/u);
  assert.match(sql, /'capability_freshness', 'not_observed_by_sql'/u);
  assert.doesNotMatch(sql, /'photo_effective_enabled_count_lower_bound'/u);
  assert.match(sql, /GROUP BY duplicate_detection_preset/u);
  assert.match(sql, /GROUP BY duplicate_photo_match_preset, duplicate_photo_scope/u);

  assert.match(sql, /event_sample_plus AS MATERIALIZED/u);
  assert.match(
    sql,
    /FROM moderation_events\s+WHERE created_at >= statement_timestamp\(\) - make_interval\(mins => 1440\)\s+ORDER BY created_at DESC\s+LIMIT 5001/u,
  );
  assert.match(sql, /event_sample AS MATERIALIZED[\s\S]*LIMIT 5000/u);
  assert.match(sql, /VALUES \(60\), \(1440\)/u);
  for (const ruleCode of [
    'DUPLICATE_DELETE',
    'DUPLICATE_WARN',
    'DUPLICATE_MUTE',
    'DUPLICATE_BAN',
  ]) {
    assert.match(sql, new RegExp(`'${ruleCode}'`, 'u'));
  }
  assert.match(sql, /'audit', 'recent_duplicate_moderation'/u);
  assert.match(sql, /'unrecognized_rule_count'/u);

  assert.match(sql, /intent_sample_plus AS MATERIALIZED/u);
  const intentSamples = sql.slice(
    sql.indexOf('intent_sample_plus AS MATERIALIZED'),
    sql.indexOf('), ranked_intents AS MATERIALIZED'),
  );
  const boundedStatuses = [
    ...intentSamples.matchAll(
      /FROM moderation_delete_intents\s+WHERE status = '([A-Z_]+)'::"ModerationDeleteIntentStatus"\s+AND updated_at >= statement_timestamp\(\) - make_interval\(mins => 1440\)\s+ORDER BY updated_at DESC\s+LIMIT 65/gu,
    ),
  ].map((match) => match[1]);
  assert.deepEqual(boundedStatuses, [
    'OBSERVED',
    'PENDING',
    'IN_PROGRESS',
    'RETRYABLE',
    'WAITING_CAPABILITY',
    'AMBIGUOUS',
    'SUCCEEDED',
    'ALREADY_ABSENT',
    'EXPIRED',
    'FAILED_TERMINAL',
  ]);
  assert.equal([...intentSamples.matchAll(/UNION ALL/gu)].length, 9);
  assert.doesNotMatch(intentSamples, /CROSS JOIN LATERAL|status = intent_statuses\.status/u);
  assert.match(sql, /WHERE sample_rank <= 64/u);
  assert.match(
    sql,
    /FROM moderation_delete_intent_reasons\s+WHERE intent_id = intent_sample\.id\s+ORDER BY reason_key ASC\s+LIMIT 9/u,
  );
  assert.match(sql, /'audit', 'recent_duplicate_delete_intents'/u);
  assert.match(sql, /'sample_cap_per_status', 64/u);
  assert.match(sql, /'reason_sample_cap_per_intent', 8/u);
  assert.match(sql, /'sample_saturated'/u);
  assert.match(sql, /'complete'/u);

  assert.doesNotMatch(
    extractDuplicateReportSql(sql),
    /raw_payload|normalized_payload|error_message|source_ip|chat_id|user_id|message_id|masked_excerpt|candidate_failures|last_error/u,
  );
});

test('duplicate explain plans only the fixed intent query and forwards no operator SQL', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  const result = runAudit(data, ['duplicate', '--explain']);
  assert.equal(result.status, 0, result.stderr);
  const sql = readFileSync(data.sql, 'utf8');
  const reportSql = extractDuplicateReportSql(sql);
  assert.match(reportSql, /^EXPLAIN \(FORMAT JSON\)\s+WITH intent_statuses/u);
  assert.equal([...reportSql.matchAll(/EXPLAIN/gu)].length, 1);
  assert.doesNotMatch(reportSql, /ANALYZE|duplicate_settings|recent_duplicate_moderation/u);
  assert.match(sql, /required_duplicate_indexes/u);
  assert.match(sql, /17 = \(/u);
  assert.equal(runConnect(data, ['postgres-audit', 'duplicate', '--explain']).status, 0);
  assert.match(
    readFileSync(data.sshArgs, 'utf8'),
    /vps-postgres-audit\.sh.*duplicate.*--explain/su,
  );
  for (const args of [
    ['duplicate', '--analyze'],
    ['duplicate', '--explain', 'SELECT 1'],
    ['all', '--explain'],
  ]) {
    rmSync(data.dockerArgs, { force: true });
    rmSync(data.sshArgs, { force: true });
    assert.equal(runAudit(data, args).status, 2);
    assert.equal(runConnect(data, ['postgres-audit', ...args]).status, 2);
    assert.equal(existsSync(data.dockerArgs), false);
    assert.equal(existsSync(data.sshArgs), false);
  }
});

test('all public audit mode includes the duplicate catalog report', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));

  const result = runAudit(data, ['all']);
  assert.equal(result.status, 0, result.stderr);
  const sql = readFileSync(data.sql, 'utf8');
  assert.match(sql, /'audit', 'webhook_queue'/u);
  assert.match(sql, /'audit', 'postgres_activity'/u);
  assert.match(sql, /'audit', 'duplicate_settings'/u);
  assert.match(sql, /'audit', 'recent_duplicate_moderation'/u);
  assert.match(sql, /'audit', 'recent_duplicate_delete_intents'/u);
});

test('duplicate SQL executes, grants converge, and each bounded source has an indexed plan', async (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  const result = runAudit(data, ['duplicate']);
  assert.equal(result.status, 0, result.stderr);
  const emittedSql = readFileSync(data.sql, 'utf8');
  const reportSql = extractDuplicateReportSql(emittedSql);
  const readinessSql = extractDuplicateReadinessSql(emittedSql);
  const database = new PGlite();
  t.after(() => database.close());

  await database.exec(`
    CREATE TYPE "DuplicateDetectionPreset" AS ENUM ('STANDARD', 'STRICT', 'CUSTOM');
    CREATE TYPE "DuplicatePhotoMatchPreset" AS ENUM ('SAME_IMAGE', 'MINOR_EDITS');
    CREATE TYPE "DuplicatePhotoScope" AS ENUM ('SAME_AUTHOR', 'CHAT');
    CREATE TYPE "SanctionAction" AS ENUM ('NONE', 'WARN', 'DELETE_MESSAGE', 'MUTE', 'KICK', 'BAN');
    CREATE TYPE "ModerationDeleteIntentStatus" AS ENUM (
      'OBSERVED',
      'PENDING',
      'IN_PROGRESS',
      'RETRYABLE',
      'WAITING_CAPABILITY',
      'AMBIGUOUS',
      'SUCCEEDED',
      'ALREADY_ABSENT',
      'EXPIRED',
      'FAILED_TERMINAL'
    );
    CREATE TABLE chat_settings (
      id TEXT PRIMARY KEY,
      anti_duplicate_enabled BOOLEAN NOT NULL,
      duplicate_photo_enabled BOOLEAN NOT NULL,
      duplicate_detection_preset "DuplicateDetectionPreset" NOT NULL,
      duplicate_photo_match_preset "DuplicatePhotoMatchPreset" NOT NULL,
      duplicate_photo_scope "DuplicatePhotoScope" NOT NULL,
      duplicate_compare_mode TEXT NOT NULL DEFAULT 'MESSAGE',
      duplicate_window_mode TEXT NOT NULL DEFAULT 'INTERVAL',
      duplicate_start_time_minutes INTEGER NOT NULL DEFAULT 540,
      duplicate_end_time_minutes INTEGER NOT NULL DEFAULT 1080,
      duplicate_timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
      chat_id TEXT
    );
    CREATE TABLE moderation_events (
      id TEXT PRIMARY KEY,
      rule_code TEXT NOT NULL,
      action "SanctionAction" NOT NULL,
      created_at TIMESTAMP NOT NULL
    );
    CREATE INDEX moderation_events_created_at_idx ON moderation_events(created_at);
    CREATE TABLE webhook_events (id TEXT PRIMARY KEY);
    CREATE TABLE publisher_entity_bindings (
      chat_id TEXT PRIMARY KEY, status TEXT, bot_access_state TEXT,
      bot_access_checked_at TIMESTAMP, bot_access_expires_at TIMESTAMP,
      send_route_quarantined_until TIMESTAMP, publisher_bot_id TEXT,
      last_webhook_at TIMESTAMP, bot_access_source TEXT
    );
    CREATE TABLE publisher_entity_settings (
      chat_id TEXT PRIMARY KEY, chat_comments_enabled BOOLEAN,
      chat_comments_admins_enabled BOOLEAN, chat_comments_posts_enabled BOOLEAN,
      channel_comments_enabled BOOLEAN, updated_at TIMESTAMP, updated_by_user_id TEXT
    );
    CREATE TABLE managed_entity_publication_policies (
      chat_id TEXT PRIMARY KEY, publik_enabled BOOLEAN, updated_by_user_id TEXT
    );
    CREATE TABLE chat_rules (
      chat_id TEXT PRIMARY KEY,
      published_message_id TEXT,
      published_bot_id TEXT,
      publish_operation_id TEXT,
      publish_send_started_at TIMESTAMP,
      pending_cleanup_message_id TEXT,
      pending_cleanup_bot_id TEXT,
      pending_cleanup_intent_id TEXT,
      pending_cleanup_kind TEXT,
      updated_at TIMESTAMP,
      text TEXT
    );
    CREATE TABLE moderation_delete_intents (
      id TEXT PRIMARY KEY,
      status "ModerationDeleteIntentStatus" NOT NULL,
      updated_at TIMESTAMP NOT NULL,
      message_id TEXT,
      next_attempt_at TIMESTAMP,
      execute_at TIMESTAMP,
      lease_expires_at TIMESTAMP,
      completed_at TIMESTAMP,
      chat_id TEXT,
      created_at TIMESTAMP
    );
    CREATE INDEX moderation_delete_intents_retention_idx
      ON moderation_delete_intents(status, updated_at);
    CREATE INDEX moderation_delete_intents_due_idx
      ON moderation_delete_intents(status, next_attempt_at, execute_at);
    CREATE INDEX moderation_delete_intents_lease_idx
      ON moderation_delete_intents(status, lease_expires_at);
    CREATE INDEX moderation_delete_intents_completed_id_idx
      ON moderation_delete_intents(completed_at DESC, id DESC);
    CREATE INDEX moderation_delete_intents_chat_status_created_idx
      ON moderation_delete_intents(chat_id, status, created_at);
    CREATE UNIQUE INDEX moderation_delete_intents_chat_message_key
      ON moderation_delete_intents(chat_id, message_id);
    CREATE TABLE moderation_delete_intent_reasons (
      id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL,
      reason_key TEXT NOT NULL,
      rule_code TEXT NOT NULL,
      masked_excerpt TEXT
    );
    CREATE UNIQUE INDEX moderation_delete_intent_reasons_intent_reason_key
      ON moderation_delete_intent_reasons(intent_id, reason_key);

    CREATE ROLE maxim_audit NOLOGIN;
    GRANT SELECT (chat_id), UPDATE (chat_id) ON TABLE chat_settings TO maxim_audit;
    GRANT SELECT (message_id) ON TABLE moderation_delete_intents TO maxim_audit;
    GRANT SELECT (masked_excerpt) ON TABLE moderation_delete_intent_reasons TO maxim_audit;
    GRANT USAGE ON SCHEMA public TO maxim_audit;
    GRANT SELECT ON TABLE webhook_events, moderation_events TO maxim_audit;
    GRANT pg_read_all_stats TO maxim_audit;

    INSERT INTO chat_settings (
      id,
      anti_duplicate_enabled,
      duplicate_photo_enabled,
      duplicate_detection_preset,
      duplicate_photo_match_preset,
      duplicate_photo_scope
    ) VALUES
      ('settings-enabled', TRUE, TRUE, 'STRICT', 'SAME_IMAGE', 'SAME_AUTHOR'),
      ('settings-disabled', FALSE, FALSE, 'STANDARD', 'SAME_IMAGE', 'SAME_AUTHOR');
    INSERT INTO moderation_events VALUES
      (
        'event-duplicate',
        'DUPLICATE_DELETE',
        'DELETE_MESSAGE',
        CURRENT_TIMESTAMP - INTERVAL '5 minutes'
      ),
      ('event-other', 'OTHER', 'NONE', CURRENT_TIMESTAMP - INTERVAL '10 minutes');
    INSERT INTO moderation_events (id, rule_code, action, created_at)
    SELECT
      'event-old-' || sample_number::text,
      'OTHER',
      'NONE',
      CURRENT_TIMESTAMP - INTERVAL '2 hours'
    FROM generate_series(1, 5001) AS sample(sample_number);
    INSERT INTO moderation_delete_intents (id, status, updated_at) VALUES
      ('intent-duplicate', 'SUCCEEDED', CURRENT_TIMESTAMP - INTERVAL '5 minutes'),
      ('intent-other', 'PENDING', CURRENT_TIMESTAMP - INTERVAL '10 minutes');
    INSERT INTO moderation_delete_intents (id, status, updated_at)
    SELECT
      'intent-old-' || sample_number::text,
      'OBSERVED',
      CURRENT_TIMESTAMP - INTERVAL '2 hours'
    FROM generate_series(1, 65) AS sample(sample_number);
    INSERT INTO moderation_delete_intent_reasons (
      id,
      intent_id,
      reason_key,
      rule_code
    ) VALUES
      ('reason-duplicate', 'intent-duplicate', 'duplicate', 'DUPLICATE_DELETE'),
      ('reason-other', 'intent-other', 'other', 'OTHER');
    INSERT INTO moderation_delete_intent_reasons (id, intent_id, reason_key, rule_code)
    SELECT
      'reason-old-' || sample_number::text,
      'intent-old-' || sample_number::text,
      'duplicate',
      'DUPLICATE_DELETE'
    FROM generate_series(1, 65) AS sample(sample_number);
    ANALYZE;
    SET enable_seqscan = off;
    SET enable_bitmapscan = off;
  `);
  await database.exec(
    readFileSync(resolve(root, 'infra/scripts/test-fixtures/publisher-publications.sql'), 'utf8'),
  );
  const columnResetSql = extractAuditColumnResetSql();
  await database.exec(columnResetSql);
  await database.exec(columnResetSql);
  const publicationPrivileges = buildPublisherPublicationPrivilegesSql(true).split('\\gset')[0];
  assert.equal(
    (await database.query(publicationPrivileges)).rows[0].publisher_publication_audit_ready,
    true,
  );

  const privilegeResult = await database.query(`
    SELECT
      has_column_privilege(
        'maxim_audit',
        'chat_settings',
        'anti_duplicate_enabled',
        'SELECT'
      ) AS settings_column,
      has_column_privilege(
        'maxim_audit',
        'moderation_delete_intents',
        'updated_at',
        'SELECT'
      ) AS intent_column,
      has_column_privilege(
        'maxim_audit',
        'moderation_delete_intent_reasons',
        'rule_code',
        'SELECT'
      ) AS reason_column,
      has_table_privilege('maxim_audit', 'chat_settings', 'SELECT') AS settings_table,
      has_table_privilege(
        'maxim_audit',
        'moderation_delete_intents',
        'SELECT'
      ) AS intent_table,
      has_table_privilege(
        'maxim_audit',
        'moderation_delete_intent_reasons',
        'SELECT'
      ) AS reason_table,
      has_column_privilege('maxim_audit', 'chat_settings', 'chat_id', 'SELECT')
        AS extra_settings_select,
      has_column_privilege('maxim_audit', 'chat_settings', 'chat_id', 'UPDATE')
        AS extra_settings_update,
      has_column_privilege(
        'maxim_audit',
        'moderation_delete_intents',
        'message_id',
        'SELECT'
      ) AS extra_intent_select,
      has_column_privilege(
        'maxim_audit',
        'moderation_delete_intent_reasons',
        'masked_excerpt',
        'SELECT'
      ) AS extra_reason_select,
      (
        SELECT count(DISTINCT (table_name, column_name, privilege_type))::integer
        FROM information_schema.role_column_grants
        WHERE grantee = 'maxim_audit'
          AND table_schema = 'public'
          AND table_name IN (
            'chat_settings',
            'moderation_delete_intents',
            'moderation_delete_intent_reasons'
          )
      ) AS exact_grant_count
  `);
  assert.deepEqual(privilegeResult.rows[0], {
    settings_column: true,
    intent_column: true,
    reason_column: true,
    settings_table: false,
    intent_table: false,
    reason_table: false,
    extra_settings_select: false,
    extra_settings_update: false,
    extra_intent_select: false,
    extra_reason_select: false,
    exact_grant_count: 17,
  });

  const verificationSql = extractProvisionVerificationSql();
  await database.exec(verificationSql);

  // FLAG: Older and partial catalogs retain zero receipt access; complete catalogs
  // converge to exact metadata access, including after stale direct grants.
  await database.exec('CREATE TABLE _prisma_migrations (id text, private_extra text);');
  await database.exec(columnResetSql);
  await database.exec(verificationSql);
  assert.equal(
    (
      await database.query(`SELECT has_column_privilege('maxim_audit',
      '_prisma_migrations', 'id', 'SELECT') AS allowed`)
    ).rows[0].allowed,
    false,
  );
  await database.exec(`ALTER TABLE _prisma_migrations ADD migration_name text,
    ADD checksum text, ADD started_at timestamptz, ADD finished_at timestamptz,
    ADD rolled_back_at timestamptz, ADD applied_steps_count int, ADD logs text;
    GRANT SELECT (private_extra), UPDATE (id) ON _prisma_migrations TO maxim_audit;`);
  await database.exec(columnResetSql);
  await database.exec(columnResetSql);
  await database.exec(verificationSql);
  assert.equal(
    (
      await database.query(`SELECT count(*)::integer AS granted
      FROM information_schema.role_column_grants WHERE grantee='maxim_audit'
      AND table_name='_prisma_migrations'`)
    ).rows[0].granted,
    8,
  );
  for (const [grant, revoke] of [
    ['SELECT (private_extra) TO PUBLIC', 'SELECT (private_extra) FROM PUBLIC'],
    ['UPDATE (id) TO PUBLIC', 'UPDATE (id) FROM PUBLIC'],
    [
      'SELECT (private_extra) TO pg_read_all_stats',
      'SELECT (private_extra) FROM pg_read_all_stats',
    ],
    ['SELECT TO PUBLIC', 'SELECT FROM PUBLIC'],
  ]) {
    const command = (verb, spec) =>
      `${verb} ${spec.replace(' TO ', ' ON _prisma_migrations TO ').replace(' FROM ', ' ON _prisma_migrations FROM ')}`;
    await database.exec(command('GRANT', grant));
    await assert.rejects(
      database.exec(verificationSql),
      /receipt metadata privileges are not exact/u,
    );
    await database.exec(command('REVOKE', revoke));
  }
  await database.exec('REVOKE SELECT (logs) ON _prisma_migrations FROM maxim_audit;');
  await assert.rejects(
    database.exec(verificationSql),
    /receipt metadata privileges are not exact/u,
  );
  await database.exec(columnResetSql);
  await database.exec(verificationSql);

  await database.exec('GRANT SELECT (bot_access_source) ON publisher_entity_bindings TO PUBLIC;');
  await assert.rejects(
    database.exec(verificationSql),
    /Publisher metadata privileges are not exact/u,
  );
  await database.exec(
    'REVOKE SELECT (bot_access_source) ON publisher_entity_bindings FROM PUBLIC;',
  );
  await database.exec(`
    INSERT INTO publisher_entity_bindings
      (chat_id, status, bot_access_state, bot_access_expires_at)
    VALUES ('-123', 'ACTIVE', 'CONFIRMED_ADMIN', CURRENT_TIMESTAMP + interval '1 hour');
    INSERT INTO publisher_entity_settings (chat_id, chat_comments_enabled)
    VALUES ('-123', false);
  `);

  await database.exec('GRANT SELECT (text) ON TABLE chat_rules TO PUBLIC;');
  await assert.rejects(database.exec(verificationSql), /rules metadata privileges are not exact/u);
  await database.exec('REVOKE SELECT (text) ON TABLE chat_rules FROM PUBLIC;');
  await database.exec(`
    INSERT INTO chat_rules (chat_id, pending_cleanup_message_id, pending_cleanup_bot_id,
      pending_cleanup_intent_id, pending_cleanup_kind, updated_at, text)
    VALUES ('-123', 'previous-message', 'previous-bot', 'intent-duplicate', 'republish_previous',
      CURRENT_TIMESTAMP, 'private rules content');
  `);
  await database.exec('SET SESSION AUTHORIZATION maxim_audit;');
  assert.equal(
    (await database.query(buildPublisherPublicationsAuditSql())).rows[0].json_build_object.audit,
    'publisher_publications',
  );
  const rulesReport = (await database.query(buildRulesCleanupAuditSql('-123'))).rows[0]
    .json_build_object;
  assert.equal(rulesReport.pending_cleanup_bot_id, 'previous-bot');
  assert.equal(rulesReport.linked_intent_status, 'SUCCEEDED');
  assert.equal((await database.query(buildRulesCleanupAuditSql('-456'))).rows.length, 0);
  await assert.rejects(database.query('SELECT text FROM chat_rules'), /permission denied/u);
  await database.exec('SET enable_seqscan = off;');
  const rulesPlan = JSON.stringify(
    (await database.query(buildRulesCleanupAuditSql('-123', true))).rows,
  );
  assert.match(rulesPlan, /chat_rules_pkey/u);
  assert.match(rulesPlan, /moderation_delete_intents_pkey/u);
  const commentsReport = (await database.query(buildPublisherCommentsAuditSql('-123'))).rows[0]
    .json_build_object;
  assert.equal(commentsReport.binding_present, true);
  assert.equal(commentsReport.access_expired, false);
  assert.equal(commentsReport.chat_comments_enabled, false);
  assert.equal(commentsReport.publik_enabled, true);
  assert.equal(
    (await database.query(buildPublisherCommentsAuditSql('-456'))).rows[0].json_build_object
      .binding_present,
    false,
  );
  const commentsPlan = JSON.stringify(
    (await database.query(buildPublisherCommentsAuditSql('-123', true))).rows,
  );
  for (const table of [
    'publisher_entity_bindings',
    'publisher_entity_settings',
    'managed_entity_publication_policies',
  ]) {
    assert.match(commentsPlan, new RegExp(`${table}_pkey`, 'u'));
  }
  await assert.rejects(
    database.query('SELECT bot_access_source FROM publisher_entity_bindings'),
    /permission denied/u,
  );
  await database.exec('SET SESSION AUTHORIZATION postgres;');

  await database.exec('GRANT SELECT (chat_id) ON TABLE chat_settings TO PUBLIC;');
  await assert.rejects(
    database.exec(verificationSql),
    /unexpected effective Antiduplicate column privileges/u,
  );
  await database.exec('REVOKE SELECT (chat_id) ON TABLE chat_settings FROM PUBLIC;');

  await database.exec('GRANT SELECT (chat_id) ON TABLE chat_settings TO pg_read_all_stats;');
  await assert.rejects(
    database.exec(verificationSql),
    /unexpected effective Antiduplicate column privileges/u,
  );
  await database.exec('REVOKE SELECT (chat_id) ON TABLE chat_settings FROM pg_read_all_stats;');
  await database.exec(verificationSql);

  await database.exec('SET SESSION AUTHORIZATION maxim_audit;');
  assert.equal((await database.query(readinessSql)).rows[0]?.duplicate_audit_ready, 'true');

  const reports = (await database.exec(reportSql))
    .flatMap((statement) => statement.rows ?? [])
    .map((row) => JSON.parse(row.json_build_object));
  await database.exec('SET SESSION AUTHORIZATION postgres;');
  assert.equal(reports.length, 3);
  assert.equal(reports[0]?.audit, 'duplicate_settings');
  assert.equal(reports[0]?.schema_version, 2);
  assert.equal(reports[0]?.runtime_authority, 'not_observed_by_sql');
  assert.equal(reports[0]?.capability_freshness, 'not_observed_by_sql');
  assert.equal(reports[0]?.saved_eligibility.master_enabled_count_lower_bound, 1);
  assert.equal(reports[0]?.saved_eligibility.image_eligible_count_lower_bound, 1);
  assert.equal(reports[0]?.legacy_compatibility.controls_current_image_policy, false);
  assert.equal(reports[1]?.audit, 'recent_duplicate_moderation');
  assert.equal(reports[1]?.rows.length, 2);
  assert.equal(reports[2]?.audit, 'recent_duplicate_delete_intents');

  const oneHourEvents = reports[1]?.windows.find((row) => row.window_minutes === 60);
  const oneDayEvents = reports[1]?.windows.find((row) => row.window_minutes === 1440);
  assert.deepEqual(oneHourEvents, {
    window_minutes: 60,
    sampled_rows: 2,
    count_lower_bound: 1,
    unrecognized_rule_count: 0,
    sample_saturated: false,
    complete: true,
  });
  assert.deepEqual(oneDayEvents, {
    window_minutes: 1440,
    sampled_rows: 5000,
    count_lower_bound: 1,
    unrecognized_rule_count: 0,
    sample_saturated: true,
    complete: false,
  });

  const oneHourObservedIntents = reports[2]?.rows.find(
    (row) => row.window_minutes === 60 && row.status === 'OBSERVED',
  );
  const oneDayObservedIntents = reports[2]?.rows.find(
    (row) => row.window_minutes === 1440 && row.status === 'OBSERVED',
  );
  assert.deepEqual(oneHourObservedIntents, {
    window_minutes: 60,
    status: 'OBSERVED',
    sampled_intents: 0,
    count_lower_bound: 0,
    saturated_reason_intents: 0,
    sample_saturated: false,
    complete: true,
  });
  assert.deepEqual(oneDayObservedIntents, {
    window_minutes: 1440,
    status: 'OBSERVED',
    sampled_intents: 64,
    count_lower_bound: 64,
    saturated_reason_intents: 0,
    sample_saturated: true,
    complete: false,
  });

  await database.exec(`
    INSERT INTO chat_settings (
      id, anti_duplicate_enabled, duplicate_photo_enabled, duplicate_detection_preset,
      duplicate_photo_match_preset, duplicate_photo_scope, duplicate_compare_mode,
      duplicate_window_mode, duplicate_start_time_minutes, duplicate_end_time_minutes,
      duplicate_timezone
    ) VALUES
      ('settings-new-image', TRUE, FALSE, 'CUSTOM', 'MINOR_EDITS', 'SAME_AUTHOR',
        'MESSAGE', 'INTERVAL', 540, 1080, 'Europe/Moscow'),
      ('settings-text-only', TRUE, TRUE, 'STRICT', 'MINOR_EDITS', 'CHAT',
        'TEXT', 'INTERVAL', 540, 1080, 'Europe/Moscow'),
      ('settings-daily-image', TRUE, FALSE, 'STRICT', 'MINOR_EDITS', 'CHAT',
        'MESSAGE', 'DAILY', 1080, 540, 'Europe/Moscow'),
      ('settings-daily-equal', TRUE, FALSE, 'STRICT', 'SAME_IMAGE', 'CHAT',
        'MESSAGE', 'DAILY', 540, 540, 'Europe/Moscow'),
      ('settings-daily-invalid-zone', TRUE, FALSE, 'STRICT', 'SAME_IMAGE', 'CHAT',
        'MESSAGE', 'DAILY', 540, 1080, 'invalid/zone'),
      ('settings-off-photo', FALSE, TRUE, 'STRICT', 'SAME_IMAGE', 'CHAT',
        'MESSAGE', 'INTERVAL', 540, 1080, 'Europe/Moscow'),
      ('settings-invalid-compare', TRUE, FALSE, 'STRICT', 'SAME_IMAGE', 'CHAT',
        'INVALID', 'INTERVAL', 540, 1080, 'Europe/Moscow'),
      ('settings-invalid-window', TRUE, FALSE, 'STRICT', 'SAME_IMAGE', 'CHAT',
        'MESSAGE', 'INVALID', 540, 1080, 'Europe/Moscow');
    SET SESSION AUTHORIZATION maxim_audit;
  `);
  const settingsReportSql = reportSql.slice(0, reportSql.indexOf(';') + 1);
  const updatedSettingsReport = JSON.parse(
    (await database.query(settingsReportSql)).rows[0].json_build_object,
  );
  await database.exec('SET SESSION AUTHORIZATION postgres;');
  assert.deepEqual(updatedSettingsReport.saved_eligibility, {
    basis: 'master_compare_mode_scope_schedule',
    master_enabled_count_lower_bound: 8,
    image_eligible_count_lower_bound: 3,
    text_only_count_lower_bound: 1,
    invalid_image_configuration_count_lower_bound: 4,
    daily_current_period: 'not_evaluated',
    image_policies: [
      { scope: 'CHAT', window_mode: 'DAILY', count_lower_bound: 1 },
      { scope: 'SAME_AUTHOR', window_mode: 'INTERVAL', count_lower_bound: 2 },
    ],
  });
  assert.equal(
    updatedSettingsReport.legacy_compatibility.master_and_photo_toggle_count_lower_bound,
    2,
  );
  assert.equal(
    updatedSettingsReport.legacy_compatibility.photo_toggle_without_master_count_lower_bound,
    1,
  );
  assert.equal(updatedSettingsReport.complete, true);
  assert.equal(updatedSettingsReport.sampled_count, 10);

  for (const timezone of [
    'europe/moscow',
    ' Europe/Moscow ',
    '+01',
    '+0100',
    '+01:00',
    ' +01:00 ',
  ]) {
    await database.query(
      "UPDATE chat_settings SET duplicate_timezone = $1 WHERE id = 'settings-daily-image'",
      [timezone],
    );
    await database.exec('SET SESSION AUTHORIZATION maxim_audit;');
    const report = JSON.parse((await database.query(settingsReportSql)).rows[0].json_build_object);
    await database.exec('SET SESSION AUTHORIZATION postgres;');
    assert.equal(report.saved_eligibility.image_eligible_count_lower_bound, 3, timezone);
  }

  await database.exec('REVOKE SELECT (duplicate_compare_mode) ON chat_settings FROM maxim_audit;');
  assert.equal((await database.query(readinessSql)).rows[0]?.duplicate_audit_ready, 'false');
  await database.exec(columnResetSql);
  assert.equal((await database.query(readinessSql)).rows[0]?.duplicate_audit_ready, 'true');

  await database.exec(`
    INSERT INTO chat_settings (
      id, anti_duplicate_enabled, duplicate_photo_enabled, duplicate_detection_preset,
      duplicate_photo_match_preset, duplicate_photo_scope
    ) SELECT 'zz-settings-' || sample_number::text, TRUE, FALSE, 'STRICT',
      'SAME_IMAGE', 'SAME_AUTHOR' FROM generate_series(1, 5001) sample(sample_number);
    SET SESSION AUTHORIZATION maxim_audit;
  `);
  const saturatedSettingsReport = JSON.parse(
    (await database.query(settingsReportSql)).rows[0].json_build_object,
  );
  await database.exec('SET SESSION AUTHORIZATION postgres;');
  assert.equal(saturatedSettingsReport.sampled_count, 5000);
  assert.equal(saturatedSettingsReport.sample_saturated, true);
  assert.equal(saturatedSettingsReport.complete, false);
  assert.equal(saturatedSettingsReport.saved_eligibility.image_eligible_count_lower_bound, 4993);

  await database.exec(`
    INSERT INTO moderation_delete_intents (id, status, updated_at)
    SELECT 'intent-skew-' || status::text || '-' || sample_number, status,
      CURRENT_TIMESTAMP - sample_number * INTERVAL '1 second'
    FROM unnest(enum_range(NULL::"ModerationDeleteIntentStatus")) AS statuses(status)
    CROSS JOIN LATERAL generate_series(1, CASE WHEN status = 'SUCCEEDED' THEN 10000 ELSE 1000 END)
      AS samples(sample_number);
    ANALYZE moderation_delete_intents;
  `);
  const intentSql = reportSql.slice(
    reportSql.indexOf('WITH intent_statuses(status_order, status)'),
  );
  const fullIntentPlan = await database.query(`EXPLAIN (FORMAT JSON, COSTS FALSE) ${intentSql}`);
  const sourceScans = [];
  const collectSourceScans = (node, parent = null) => {
    if (node['Relation Name'] === 'moderation_delete_intents') sourceScans.push({ node, parent });
    for (const child of node.Plans ?? []) collectSourceScans(child, node);
  };
  collectSourceScans(fullIntentPlan.rows[0]['QUERY PLAN'][0].Plan);
  assert.equal(sourceScans.length, 10);
  for (const { node: scan, parent } of sourceScans) {
    assert.equal(parent?.['Node Type'], 'Limit');
    assert.equal(scan['Index Name'], 'moderation_delete_intents_retention_idx');
    assert.equal(scan['Scan Direction'], 'Backward');
    assert.match(scan['Index Cond'], /status.*updated_at/u);
  }

  const indexedQueries = [
    {
      index: 'chat_settings_pkey',
      sql: 'SELECT id FROM chat_settings ORDER BY id ASC LIMIT 5001',
    },
    {
      index: 'moderation_events_created_at_idx',
      sql: `
        SELECT rule_code, action, created_at
        FROM moderation_events
        WHERE created_at >= statement_timestamp() - make_interval(mins => 1440)
        ORDER BY created_at DESC
        LIMIT 5001
      `,
    },
    {
      index: 'moderation_delete_intents_retention_idx',
      sql: `
        SELECT id, status, updated_at
        FROM moderation_delete_intents
        WHERE status = 'PENDING'::"ModerationDeleteIntentStatus"
          AND updated_at >= statement_timestamp() - make_interval(mins => 1440)
        ORDER BY updated_at DESC
        LIMIT 65
      `,
    },
    {
      index: 'moderation_delete_intent_reasons_intent_reason_key',
      sql: `
        SELECT reason_key, rule_code
        FROM moderation_delete_intent_reasons
        WHERE intent_id = 'intent-duplicate'
        ORDER BY reason_key ASC
        LIMIT 9
      `,
    },
  ];
  for (const query of indexedQueries) {
    const plan = await database.query(`EXPLAIN (FORMAT JSON, COSTS FALSE) ${query.sql}`);
    const serializedPlan = JSON.stringify(plan.rows);
    assert.match(serializedPlan, new RegExp(query.index, 'u'));
    assert.match(serializedPlan, /"Node Type":"Index(?: Only)? Scan"/u);
    assert.doesNotMatch(
      serializedPlan,
      /"Node Type":"(?:Seq Scan|Bitmap Heap Scan|Bitmap Index Scan|Sort)"/u,
    );
  }

  const expectDuplicateReadiness = async (expected) => {
    const readiness = await database.query(readinessSql);
    assert.equal(readiness.rows[0]?.duplicate_audit_ready, expected);
  };
  await database.exec(`
    DROP INDEX moderation_events_created_at_idx;
    CREATE INDEX moderation_events_created_at_idx ON chat_settings(id);
  `);
  await expectDuplicateReadiness('false');
  await database.exec(`
    DROP INDEX moderation_events_created_at_idx;
    CREATE INDEX moderation_events_created_at_idx ON moderation_events(rule_code);
  `);
  await expectDuplicateReadiness('false');
  await database.exec(`
    DROP INDEX moderation_events_created_at_idx;
    CREATE INDEX moderation_events_created_at_idx ON moderation_events(created_at DESC);
  `);
  await expectDuplicateReadiness('false');
  await database.exec(`
    DROP INDEX moderation_events_created_at_idx;
    CREATE INDEX moderation_events_created_at_idx
      ON moderation_events(created_at)
      WHERE rule_code = 'DUPLICATE_DELETE';
  `);
  await expectDuplicateReadiness('false');
  await database.exec(`
    DROP INDEX moderation_events_created_at_idx;
    CREATE INDEX moderation_events_created_at_idx ON moderation_events(created_at);
  `);
  await expectDuplicateReadiness('true');

  await database.exec(`
    TRUNCATE moderation_events;
    TRUNCATE moderation_delete_intent_reasons;
    TRUNCATE moderation_delete_intents;
    INSERT INTO moderation_events (id, rule_code, action, created_at)
    SELECT
      'event-boundary-' || sample_number::text,
      'DUPLICATE_DELETE',
      'DELETE_MESSAGE',
      TIMESTAMP '2026-09-05 11:00:00'
    FROM generate_series(1, 5001) AS sample(sample_number);
    WITH intent_statuses(status) AS (
      VALUES
        ('OBSERVED'::"ModerationDeleteIntentStatus"),
        ('PENDING'::"ModerationDeleteIntentStatus"),
        ('IN_PROGRESS'::"ModerationDeleteIntentStatus"),
        ('RETRYABLE'::"ModerationDeleteIntentStatus"),
        ('WAITING_CAPABILITY'::"ModerationDeleteIntentStatus"),
        ('AMBIGUOUS'::"ModerationDeleteIntentStatus"),
        ('SUCCEEDED'::"ModerationDeleteIntentStatus"),
        ('ALREADY_ABSENT'::"ModerationDeleteIntentStatus"),
        ('EXPIRED'::"ModerationDeleteIntentStatus"),
        ('FAILED_TERMINAL'::"ModerationDeleteIntentStatus")
    )
    INSERT INTO moderation_delete_intents (id, status, updated_at)
    SELECT
      'intent-boundary-' || intent_statuses.status::text || '-' || sample_number::text,
      intent_statuses.status,
      TIMESTAMP '2026-09-05 11:00:00'
    FROM intent_statuses
    CROSS JOIN generate_series(1, 65) AS sample(sample_number);
    INSERT INTO moderation_delete_intent_reasons (id, intent_id, reason_key, rule_code)
    SELECT
      'reason-boundary-' || intent.id || '-' || reason_number::text,
      intent.id,
      CASE WHEN reason_number = 1 THEN '00-duplicate' ELSE 'reason-' || reason_number::text END,
      CASE WHEN reason_number = 1 THEN 'DUPLICATE_DELETE' ELSE 'OTHER' END
    FROM moderation_delete_intents AS intent
    CROSS JOIN generate_series(1, 9) AS reason(reason_number);
    ANALYZE;
  `);
  const fixedBoundarySql = reportSql.replaceAll(
    'statement_timestamp()',
    "TIMESTAMP '2026-09-05 12:00:00'",
  );
  await database.exec("SET statement_timeout = '2500ms';");
  await database.exec('SET SESSION AUTHORIZATION maxim_audit;');
  const boundaryReports = (await database.exec(fixedBoundarySql))
    .flatMap((statement) => statement.rows ?? [])
    .map((row) => JSON.parse(row.json_build_object));
  await database.exec('SET SESSION AUTHORIZATION postgres;');
  const boundaryEventWindow = boundaryReports[1]?.windows.find((row) => row.window_minutes === 60);
  const boundaryIntentWindows = boundaryReports[2]?.rows.filter((row) => row.window_minutes === 60);
  assert.equal(boundaryEventWindow?.sample_saturated, true);
  assert.equal(boundaryEventWindow?.complete, false);
  assert.equal(boundaryIntentWindows?.length, 10);
  for (const boundaryIntentWindow of boundaryIntentWindows ?? []) {
    assert.equal(boundaryIntentWindow.sampled_intents, 64);
    assert.equal(boundaryIntentWindow.count_lower_bound, 64);
    assert.equal(boundaryIntentWindow.saturated_reason_intents, 64);
    assert.equal(boundaryIntentWindow.sample_saturated, true);
    assert.equal(boundaryIntentWindow.complete, false);
  }
});

test('audit modes reject arbitrary SQL and unsafe monitor windows before Docker', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));

  for (const args of [
    ['queue', 'select 1'],
    ['monitor-signals'],
    ['monitor-signals', '0'],
    ['monitor-signals', '1441'],
    ['duplicate', 'select 1'],
    ['custom'],
  ]) {
    rmSync(data.dockerArgs, { force: true });
    const result = runAudit(data, args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.equal(existsSync(data.dockerArgs), false, args.join(' '));
  }
});

test('internal legacy queue audit is capability-gated and emits a bounded primary-key query', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  const snapshot = writeLegacyDefaultWebhookSnapshot(data);

  const denied = runAudit(data, ['legacy-default-webhook-jobs', snapshot]);
  assert.equal(denied.status, 2, denied.stderr);
  assert.equal(existsSync(data.dockerArgs), false);

  const allowed = runAudit(data, ['legacy-default-webhook-jobs', snapshot], {
    MAXIM_INTERNAL_LEGACY_DEFAULT_WEBHOOK_AUDIT: '1',
  });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), '{"mock":true}');

  const sql = readFileSync(data.sql, 'utf8');
  assert.match(sql, /^BEGIN READ ONLY;$/mu);
  assert.match(sql, /requested\(id\) AS MATERIALIZED \(\s*VALUES/u);
  assert.equal([...sql.matchAll(/::text\)/gu)].length, 2);
  assert.match(
    sql,
    /LEFT JOIN public\.webhook_events AS webhook_events ON webhook_events\.id = requested\.id/u,
  );
  assert.match(sql, /requested_count/u);
  assert.match(sql, /absent_count/u);
  assert.match(sql, /processed_count/u);
  assert.match(sql, /duplicate_count/u);
  assert.match(sql, /received_count/u);
  assert.match(sql, /queued_count/u);
  assert.match(sql, /failed_count/u);
  assert.match(sql, /quarantined_count/u);
  assert.match(sql, /retryable_failed_count/u);
  assert.match(sql, /^COMMIT;$/mu);
  assert.match(sql, /FROM pg_constraint AS primary_constraint/u);
  assert.match(sql, /JOIN pg_index AS primary_index/u);
  assert.match(sql, /primary_constraint\.contype = 'p'/u);
  assert.match(sql, /primary_index\.indisprimary/u);
  assert.match(sql, /primary_index\.indisvalid/u);

  const auditSource = readFileSync(audit, 'utf8');
  assert.match(auditSource, /prepare_audit_sql[\s\S]*<"\$AUDIT_SQL_FILE"/u);
  assert.doesNotMatch(auditSource, /< <\(emit_sql\)/u);

  const failed = runAudit(data, ['legacy-default-webhook-jobs', snapshot], {
    MAXIM_INTERNAL_LEGACY_DEFAULT_WEBHOOK_AUDIT: '1',
    MOCK_AUDIT_FAIL: '1',
  });
  assert.equal(failed.status, 7, failed.stderr);
  assert.match(failed.stderr, /failed closed/u);
  assert.doesNotMatch(failed.stderr, /fixture-event/u);
});

test('global audit flock rejects an overlapping diagnostic before Docker', async (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  const holderReady = join(data.directory, 'holder-ready');
  const holder = spawn(
    'flock',
    ['-n', data.auditLock, 'bash', '-c', ': >"$1"; sleep 5', 'audit-lock-holder', holderReady],
    { detached: true, stdio: 'ignore' },
  );
  t.after(() => {
    try {
      process.kill(-holder.pid, 'SIGKILL');
    } catch {
      // The detached holder may already have exited after the explicit cleanup below.
    }
  });
  for (let attempt = 0; attempt < 100 && !existsSync(holderReady); attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  assert.equal(existsSync(holderReady), true);

  const result = runAudit(data, ['queue']);
  assert.equal(result.status, 75, result.stderr);
  assert.match(result.stderr, /Another bounded PostgreSQL audit is already running/u);
  assert.equal(existsSync(data.dockerArgs), false);
  process.kill(-holder.pid, 'SIGTERM');
  await once(holder, 'exit');
});

test('wall timeout terminates the audit and cleans only its exact backend identity', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));

  const startedAt = Date.now();
  const result = runAudit(data, ['queue'], {
    MAXIM_POSTGRES_AUDIT_WALL_TIMEOUT_SEC: '1',
    MOCK_AUDIT_SLEEP_SEC: '5',
  });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.status, 124, result.stderr);
  assert.ok(elapsedMs < 3_000, `audit timeout took ${elapsedMs}ms`);
  assert.match(result.stderr, /audit exceeded 1s and was terminated/u);

  const args = readFileSync(data.dockerArgs, 'utf8');
  const appName = /PGAPPNAME=(maxim-bounded-audit-[A-Za-z0-9-]+)/u.exec(args)?.[1];
  assert.ok(appName);
  assert.equal(
    existsSync(data.cleanupArgs),
    true,
    `${readFileSync(data.allDockerCalls, 'utf8')}\n${result.stderr}`,
  );
  const cleanup = readFileSync(data.cleanupArgs, 'utf8');
  assert.match(cleanup, new RegExp(`application_name = '${appName}'`, 'u'));
  for (const pidFile of [data.dockerPid, data.sleepPid]) {
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
});

test('SIGTERM preserves signal status and cleans the exact audit backend', async (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  const child = spawn('bash', [data.auditScript, 'queue'], {
    cwd: root,
    env: { ...baseEnv(data), MOCK_AUDIT_SLEEP_SEC: '5' },
    stdio: 'ignore',
  });
  t.after(() => child.kill('SIGKILL'));
  for (let attempt = 0; attempt < 100 && !existsSync(data.auditStarted); attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  assert.equal(existsSync(data.auditStarted), true);

  const terminatedAt = Date.now();
  child.kill('SIGTERM');
  const [code, signal] = await once(child, 'exit');
  const elapsedMs = Date.now() - terminatedAt;
  assert.equal(signal, null);
  assert.equal(code, 143);
  assert.ok(elapsedMs < 3_000, `SIGTERM cleanup took ${elapsedMs}ms`);
  const args = readFileSync(data.dockerArgs, 'utf8');
  const appName = /PGAPPNAME=(maxim-bounded-audit-[A-Za-z0-9-]+)/u.exec(args)?.[1];
  assert.ok(appName);
  const cleanup = readFileSync(data.cleanupArgs, 'utf8');
  assert.match(cleanup, new RegExp(`application_name = '${appName}'`, 'u'));
  for (const pidFile of [data.dockerPid, data.sleepPid]) {
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
});

test('monitor delegates its database sample to the fixed bounded audit', () => {
  assert.doesNotMatch(monitor, /\bpsql\b/u);
  assert.match(monitor, /vps-postgres-audit\.sh monitor-signals "\$SIGNAL_WINDOW_MIN"/u);
  assert.match(monitor, /SIGNAL_WINDOW_MIN > 1440/u);
});

test('provisioning is preview-only by default and declares a hardened idempotent role', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));

  const preview = spawnSync('bash', [provision], {
    cwd: root,
    encoding: 'utf8',
    env: baseEnv(data),
  });
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /Preview only; no database state changed/u);
  assert.equal(existsSync(data.dockerArgs), false);

  const source = readFileSync(provision, 'utf8');
  assert.match(source, /IF NOT EXISTS[\s\S]*CREATE ROLE maxim_audit/u);
  assert.match(source, /NOSUPERUSER/u);
  assert.match(source, /NOBYPASSRLS/u);
  assert.match(source, /CONNECTION LIMIT 1/u);
  assert.match(source, /PASSWORD NULL/u);
  assert.match(source, /REVOKE pg_read_all_data FROM maxim_audit/u);
  assert.doesNotMatch(source, /GRANT pg_read_all_data/u);
  assert.match(source, /GRANT USAGE ON SCHEMA public TO maxim_audit/u);
  assert.match(source, /DO \$revoke_audit_columns\$/u);
  assert.match(source, /string_agg\(format\('%I', column_name\)/u);
  assert.match(
    source,
    /REVOKE SELECT \(%1\$s\), INSERT \(%1\$s\), UPDATE \(%1\$s\), REFERENCES \(%1\$s\)/u,
  );
  assert.match(
    source,
    /GRANT SELECT ON TABLE public\.webhook_events, public\.moderation_events TO maxim_audit/u,
  );
  assert.match(
    source,
    /GRANT SELECT \([\s\S]*anti_duplicate_enabled[\s\S]*duplicate_photo_scope[\s\S]*\) ON TABLE public\.chat_settings TO maxim_audit/u,
  );
  assert.match(
    source,
    /GRANT SELECT \([\s\S]*status[\s\S]*updated_at[\s\S]*\) ON TABLE public\.moderation_delete_intents TO maxim_audit/u,
  );
  assert.match(
    source,
    /GRANT SELECT \([\s\S]*intent_id[\s\S]*rule_code[\s\S]*\) ON TABLE public\.moderation_delete_intent_reasons TO maxim_audit/u,
  );
  assert.match(source, /Antiduplicate column privileges are not exact/u);
  assert.match(source, /unexpected effective Antiduplicate column privileges/u);
  assert.match(source, /restricted_relation[\s\S]*restricted_attribute/u);
  assert.match(source, /has_table_privilege\([\s\S]*public\.chat_settings[\s\S]*'SELECT'/u);
  assert.match(source, /GRANT pg_read_all_stats TO maxim_audit/u);
  assert.match(source, /ALTER ROLE maxim_audit RESET ALL/u);
  assert.match(source, /ALTER ROLE maxim_audit IN DATABASE maxim RESET ALL/u);
  assert.match(source, /AUDIT_LOCK_FILE=\/tmp\/maxim-postgres-audit\.lock/u);
  assert.match(source, /flock -n "\$AUDIT_LOCK_FD"/u);
  assert.match(source, /timeout --signal=TERM --kill-after=2s 12s/u);
  assert.match(source, /INHERIT only so the pg_read_all_stats membership takes effect/u);
  assert.match(source, /default_transaction_read_only = on/u);
  assert.match(source, /statement_timeout = '5s'/u);
  assert.match(source, /lock_timeout = '1s'/u);
  assert.match(source, /idle_in_transaction_session_timeout = '5s'/u);
  assert.match(source, /idle_session_timeout = '60s'/u);
  assert.match(source, /max_parallel_workers_per_gather = 0/u);
  assert.match(source, /enable_bitmapscan = off/u);
  assert.match(source, /jit = off/u);
  assert.match(source, /work_mem = '1MB'/u);
  assert.match(source, /temp_file_limit = '8MB'/u);
  assert.match(source, /unexpected role memberships/u);
  assert.match(source, /privilege attestation failed/u);
  assert.match(source, /unexpected direct table privileges/u);
  assert.match(source, /unexpected effective user-relation privileges/u);
});

test('vps exec blocks obvious raw database CLIs before SSH', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));

  for (const rawCommand of [
    'docker compose exec -T postgres psql -U maxim -d maxim',
    '/usr/bin/pg_dump maxim',
    'docker exec postgres pg_restore backup.dump',
    'docker compose exec -T postgres sh',
    'docker exec -it infra-postgres-1 bash',
    'docker compose run --rm postgres sh',
  ]) {
    rmSync(data.sshArgs, { force: true });
    const result = runConnect(data, ['exec', rawCommand]);
    assert.equal(result.status, 2, `${rawCommand}: ${result.stderr}`);
    assert.match(result.stderr, /PostgreSQL CLIs and interactive VPS shells are break-glass/u);
    assert.equal(existsSync(data.sshArgs), false, rawCommand);
  }
});

test('database break-glass requires caller flag and non-empty reason together', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  const command =
    'docker compose exec -T postgres psql -U maxim -d maxim -c select_sensitive_marker';

  for (const extraEnv of [
    { MAXIM_VPS_DATABASE_BREAK_GLASS: '1' },
    { MAXIM_VPS_DATABASE_BREAK_GLASS_REASON: 'incident-review' },
    {
      MAXIM_VPS_DATABASE_BREAK_GLASS: '1',
      MAXIM_VPS_DATABASE_BREAK_GLASS_REASON: '   ',
    },
  ]) {
    rmSync(data.sshArgs, { force: true });
    const result = runConnect(data, ['exec', command], extraEnv);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(existsSync(data.sshArgs), false);
    assert.doesNotMatch(result.stderr, /select_sensitive_marker/u);
  }

  const allowed = runConnect(data, ['exec', command], {
    MAXIM_VPS_DATABASE_BREAK_GLASS: '1',
    MAXIM_VPS_DATABASE_BREAK_GLASS_REASON: 'reviewed incident diagnosis',
  });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stderr, /reviewed break-glass operation accepted/u);
  assert.equal(existsSync(data.sshArgs), true);
});

test('a persistent VPS env file cannot silently enable the raw database bypass', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  writeFileSync(
    data.envFile,
    'MAXIM_VPS_DATABASE_BREAK_GLASS=1\nMAXIM_VPS_DATABASE_BREAK_GLASS_REASON=persisted\n',
  );

  const result = runConnect(data, ['exec', 'psql -U maxim -d maxim']);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(existsSync(data.sshArgs), false);
});

test('interactive VPS shell is break-glass and never accepts a persisted bypass', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));

  const denied = runConnect(data, ['shell']);
  assert.equal(denied.status, 2, denied.stderr);
  assert.equal(existsSync(data.sshArgs), false);

  writeFileSync(
    data.envFile,
    'MAXIM_VPS_DATABASE_BREAK_GLASS=1\nMAXIM_VPS_DATABASE_BREAK_GLASS_REASON=persisted\n',
  );
  const persisted = runConnect(data, ['shell']);
  assert.equal(persisted.status, 2, persisted.stderr);
  assert.equal(existsSync(data.sshArgs), false);

  const allowed = runConnect(data, ['shell'], {
    MAXIM_VPS_DATABASE_BREAK_GLASS: '1',
    MAXIM_VPS_DATABASE_BREAK_GLASS_REASON: 'reviewed interactive recovery',
  });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stderr, /interactive VPS shell/u);
  assert.equal(existsSync(data.sshArgs), true);
});

test('Yandex interactive shell uses the same caller-only break-glass gate', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));

  const denied = runConnect(data, ['yc-shell']);
  assert.equal(denied.status, 2, denied.stderr);
  assert.equal(existsSync(data.ycArgs), false);

  const allowed = runConnect(data, ['yc-shell'], {
    MAXIM_VPS_DATABASE_BREAK_GLASS: '1',
    MAXIM_VPS_DATABASE_BREAK_GLASS_REASON: 'reviewed Yandex recovery',
  });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stderr, /interactive Yandex VPS shell/u);
  assert.equal(existsSync(data.ycArgs), true);
});

test('vps postgres-audit accepts only public fixed modes and needs no bypass', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));

  const allowed = runConnect(data, ['postgres-audit', 'queue']);
  assert.equal(allowed.status, 0, allowed.stderr);
  const sshArgs = readFileSync(data.sshArgs, 'utf8');
  assert.match(sshArgs, /vps-postgres-audit\.sh/u);
  assert.match(sshArgs, /queue/u);

  const duplicate = runConnect(data, ['postgres-audit', 'duplicate']);
  assert.equal(duplicate.status, 0, duplicate.stderr);
  assert.match(readFileSync(data.sshArgs, 'utf8'), /duplicate/u);

  const publication = runConnect(data, ['postgres-audit', 'publication-schema']);
  assert.equal(publication.status, 0, publication.stderr);
  assert.match(readFileSync(data.sshArgs, 'utf8'), /publication-schema/u);
  assert.equal(runConnect(data, ['postgres-audit', 'publication-schema', 'other']).status, 2);

  for (const privateMode of ['monitor-signals', 'legacy-default-webhook-jobs']) {
    rmSync(data.sshArgs, { force: true });
    const denied = runConnect(data, ['postgres-audit', privateMode], {
      MAXIM_INTERNAL_LEGACY_DEFAULT_WEBHOOK_AUDIT: '1',
    });
    assert.equal(denied.status, 2, denied.stderr);
    assert.equal(existsSync(data.sshArgs), false);
  }
});

test('vps audit-role provisioning is preview-only by default and accepts only --apply', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));

  const preview = runConnect(data, ['postgres-audit-provision']);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(readFileSync(data.sshArgs, 'utf8'), /vps-provision-postgres-audit-role\.sh/u);
  assert.doesNotMatch(readFileSync(data.sshArgs, 'utf8'), /--apply/u);

  const apply = runConnect(data, ['postgres-audit-provision', '--apply']);
  assert.equal(apply.status, 0, apply.stderr);
  assert.match(readFileSync(data.sshArgs, 'utf8'), /--apply/u);

  for (const args of [
    ['postgres-audit-provision', '--dry-run'],
    ['postgres-audit-provision', '--apply', 'extra'],
  ]) {
    rmSync(data.sshArgs, { force: true });
    const denied = runConnect(data, args);
    assert.equal(denied.status, 2, denied.stderr);
    assert.equal(existsSync(data.sshArgs), false);
  }
});
