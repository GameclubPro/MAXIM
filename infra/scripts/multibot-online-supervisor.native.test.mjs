import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  cancelOwnedMigrationSql,
  countOwnedMigrationSql,
  runMultibotSupervisorCommand,
  stopOwnedMigration,
  terminateOwnedMigrationSql,
} from './multibot-online-supervisor.mjs';

const nativePostgresUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim();
const composeArgs = ['--env-file', '.env', '-p', 'infra', '-f', 'infra/docker-compose.yml'];

test(
  'native supervised cleanup removes owned idle/running sessions through real psql stdin and preserves a near-prefix observer',
  { skip: !nativePostgresUrl, timeout: 30_000 },
  async () => {
    const address = new URL(nativePostgresUrl);
    assert.ok(
      ['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) &&
        address.pathname.includes('race_test'),
      'Requires the disposable local PostgreSQL race_test database',
    );
    const { default: pg } = await import('pg');
    const applicationName = `maxim-online-${randomUUID()}`;
    const clientOptions = {
      connectionString: nativePostgresUrl,
      connectionTimeoutMillis: 5_000,
      query_timeout: 25_000,
      options: '-c statement_timeout=25000 -c timezone=UTC',
    };
    const observer = new pg.Client({
      ...clientOptions,
      application_name: `${applicationName}-observer`,
    });
    const ownedIdle = new pg.Client({ ...clientOptions, application_name: applicationName });
    const ownedRunning = new pg.Client({ ...clientOptions, application_name: applicationName });
    const clients = [observer, ownedIdle, ownedRunning];
    const backendErrors = [];
    for (const client of clients)
      client.on('error', (error) => backendErrors.push({ client, code: error.code }));
    const psqlEnv = {
      ...process.env,
      PGHOST: address.hostname,
      PGPORT: address.port || '5432',
      PGUSER: decodeURIComponent(address.username),
      PGPASSWORD: decodeURIComponent(address.password),
      PGDATABASE: decodeURIComponent(address.pathname.slice(1)),
      PGOPTIONS: '-c timezone=UTC',
    };
    const commands = [];
    const sqlResults = [];
    const ownedPids = [];
    let observerConnected = false;
    let runningQuery;
    let killCount = 0;
    const run = async (command, args, options) => {
      assert.equal(command, 'docker');
      commands.push(args);
      const psqlIndex = args.indexOf('psql');
      if (psqlIndex >= 0) {
        assert.deepEqual(args.slice(0, psqlIndex), [
          'compose',
          ...composeArgs,
          'exec',
          '-T',
          'postgres',
        ]);
        assert.ok(
          [cancelOwnedMigrationSql, terminateOwnedMigrationSql, countOwnedMigrationSql].includes(
            options.input,
          ),
          'Run only the reviewed supervisor cleanup SQL verbatim',
        );
        const queryArgs = args.slice(psqlIndex + 1);
        assert.deepEqual(queryArgs, [
          '-X',
          '-v',
          'ON_ERROR_STOP=1',
          '-v',
          `owned_application_name=${applicationName}`,
          '-U',
          'maxim',
          '-d',
          'maxim',
          '-Atq',
        ]);
        // FLAG: Replace only the production role/database selectors with isolated
        // PG* environment values. Keep the actual SQL, psql variables and stdin runner.
        const localArgs = queryArgs.slice(0, 5).concat(queryArgs.slice(9));
        assert.equal(localArgs.includes(psqlEnv.PGPASSWORD), false);
        assert.equal(localArgs.includes(nativePostgresUrl), false);
        const result = await runMultibotSupervisorCommand('psql', localArgs, {
          ...options,
          env: psqlEnv,
        });
        assert.equal(result.stderr, '');
        assert.equal(result.stdout.includes(psqlEnv.PGPASSWORD), false);
        sqlResults.push({ sql: options.input, stdout: result.stdout });
        return result;
      }
      if (args[0] === 'stop') {
        assert.deepEqual(args, ['stop', '--time', '3', applicationName]);
        return { stdout: applicationName, stderr: '' };
      }
      assert.deepEqual(args, [
        'container',
        'ls',
        '--all',
        '--filter',
        `name=^/${applicationName}$`,
        '--format',
        '{{.Names}} {{.State}}',
      ]);
      return { stdout: `${applicationName} exited\n`, stderr: '' };
    };
    try {
      await observer.connect();
      observerConnected = true;
      const identity = await observer.query('SELECT version() AS version, pg_backend_pid() AS pid');
      assert.match(identity.rows[0].version, /^PostgreSQL /u);
      assert.doesNotMatch(identity.rows[0].version, /pglite|wasm/iu);
      for (const client of [ownedIdle, ownedRunning]) {
        await client.connect();
        const session = await client.query('SELECT pg_backend_pid() AS pid');
        ownedPids.push(session.rows[0].pid);
      }
      runningQuery = ownedRunning.query('SELECT pg_sleep(20)').then(
        () => ({ completed: true }),
        (error) => ({ code: error.code }),
      );
      const deadline = Date.now() + 3_000;
      let ready = false;
      while (Date.now() < deadline) {
        const sessions = await observer.query(
          `SELECT pid, state, wait_event, application_name FROM pg_stat_activity
           WHERE datname = current_database() AND pid = ANY($1::int[]) ORDER BY pid`,
          [ownedPids],
        );
        if (
          sessions.rows.length === 2 &&
          sessions.rows.every((row) => row.application_name === applicationName) &&
          sessions.rows.some((row) => row.pid === ownedPids[0] && row.state === 'idle') &&
          sessions.rows.some(
            (row) =>
              row.pid === ownedPids[1] && row.state === 'active' && row.wait_event === 'PgSleep',
          )
        ) {
          ready = true;
          break;
        }
        await delay(20);
      }
      assert.equal(ready, true, 'Owned sessions must include real idle and running backends');
      await stopOwnedMigration(
        composeArgs,
        {
          kill: (signal) => {
            assert.equal(signal, 'SIGKILL');
            killCount += 1;
          },
        },
        applicationName,
        applicationName,
        { run },
      );
      assert.equal(killCount, 1);
      assert.deepEqual(
        sqlResults.map((result) => result.sql),
        [cancelOwnedMigrationSql, terminateOwnedMigrationSql, countOwnedMigrationSql],
      );
      assert.equal(sqlResults[0].stdout.trim(), 't\nt');
      assert.equal(sqlResults[1].stdout.trim(), 't\nt');
      assert.equal(sqlResults[2].stdout.trim(), '0', 'Real absence proof must return exactly zero');
      const canceled = await runningQuery;
      assert.equal(canceled.completed, undefined);
      assert.ok(['57014', '57P01'].includes(canceled.code));
      const remaining = await observer.query(
        `SELECT pid FROM pg_stat_activity
         WHERE datname = current_database() AND application_name = $1`,
        [applicationName],
      );
      assert.deepEqual(remaining.rows, []);
      const survivor = await observer.query(
        "SELECT pg_backend_pid() AS pid, current_setting('application_name') AS application_name",
      );
      assert.deepEqual(survivor.rows, [
        { pid: identity.rows[0].pid, application_name: `${applicationName}-observer` },
      ]);
      assert.ok(commands.every((args) => !args.includes('api-ingress')));
      assert.equal(
        backendErrors.some((error) => error.client === observer),
        false,
      );
    } finally {
      try {
        if (observerConnected && ownedPids.length)
          await observer.query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
             WHERE datname = current_database() AND pid = ANY($1::int[])
               AND application_name = $2`,
            [ownedPids, applicationName],
          );
      } finally {
        await Promise.allSettled(clients.map((client) => client.end()));
        if (runningQuery) await runningQuery;
      }
    }
  },
);
