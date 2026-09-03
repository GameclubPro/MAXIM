import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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

const root = resolve(import.meta.dirname, '../..');
const audit = resolve(root, 'infra/scripts/vps-postgres-audit.sh');
const provision = resolve(root, 'infra/scripts/vps-provision-postgres-audit-role.sh');
const connect = resolve(root, 'infra/scripts/vps-connect.sh');
const monitor = readFileSync(resolve(root, 'infra/scripts/vps-monitor-readonly.sh'), 'utf8');
const schema = readFileSync(resolve(root, 'apps/api/prisma/schema.prisma'), 'utf8');

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-postgres-audit-'));
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
    { id: 'fixture-event-0002', state: 'failed', timestamp: timestamp + 1, priority: 5 },
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
  return spawnSync('bash', [audit, ...args], {
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
  assert.match(sql, /pg_size_bytes\(current_setting\('temp_file_limit'\)\) BETWEEN 0 AND 8388608/u);
  assert.match(sql, /hardened maxim_audit session invariant is missing/u);
  assert.match(sql, /to_regclass\('public\.webhook_events_status_created_at_idx'\)/u);
  assert.match(sql, /bounded_events AS MATERIALIZED/u);
  assert.match(sql, /WHERE webhook_events\.status = queue_statuses\.status/u);
  assert.match(sql, /ORDER BY webhook_events\.created_at ASC\n {4}LIMIT 2001/u);
  assert.match(sql, /'sample_cap_per_status', 2000/u);
  assert.doesNotMatch(
    sql,
    /raw_payload|normalized_payload|error_message|source_ip|chat_id|user_id|masked_excerpt/u,
  );
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
  assert.doesNotMatch(sql, /\bclient_addr\b|\busename\b|\bquery\b/u);
  assert.doesNotMatch(sql, /'application_name'|'query'/u);
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
    sql,
    /raw_payload|normalized_payload|error_message|source_ip|user_id|masked_excerpt/u,
  );
});

test('audit modes reject arbitrary SQL and unsafe monitor windows before Docker', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));

  for (const args of [
    ['queue', 'select 1'],
    ['monitor-signals'],
    ['monitor-signals', '0'],
    ['monitor-signals', '1441'],
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
    [
      '-n',
      '/tmp/maxim-postgres-audit.lock',
      'bash',
      '-c',
      ': >"$1"; sleep 5',
      'audit-lock-holder',
      holderReady,
    ],
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
  const child = spawn('bash', [audit, 'queue'], {
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
  assert.match(
    source,
    /GRANT SELECT ON TABLE public\.webhook_events, public\.moderation_events TO maxim_audit/u,
  );
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
