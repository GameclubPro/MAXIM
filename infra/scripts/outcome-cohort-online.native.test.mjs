import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createOutcomeCohortMigrationPrefix } from '../../scripts/agent/outcome-cohort-online-prepare.mjs';
import {
  OUTCOME_COHORT_TARGETS,
  readOutcomeCohortSource,
} from '../../scripts/agent/outcome-cohort-online-targets.mjs';
import {
  outcomeCohortStateSql,
  verifyOutcomeCohortPreparationState,
} from './outcome-cohort-online-state.mjs';
import { outcomeCohortCapacitySql } from './outcome-cohort-prepare-capacity.mjs';

const root = resolve(import.meta.dirname, '../..');
const nativeUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim();
const source = readOutcomeCohortSource(root);
const outcome = (result) =>
  result.find((part) => part.rows?.[0]?.json_build_object)?.rows[0].json_build_object;

test(
  'real immutable migrations, concurrent writers, retained cancellation and exact catalog/receipt gates',
  { skip: !nativeUrl, timeout: 240_000 },
  async (t) => {
    const base = new URL(nativeUrl);
    assert.ok(
      ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) &&
        base.pathname.includes('race_test'),
      'Disposable local race_test required',
    );
    const { default: pg } = await import('pg');
    const connect = async (url, applicationName) => {
      const client = new pg.Client({
        connectionString: url,
        application_name: applicationName,
        connectionTimeoutMillis: 5000,
        query_timeout: 20_000,
        options: '-c statement_timeout=15000 -c timezone=UTC',
      });
      client.on('error', () => {});
      await client.connect();
      return client;
    };
    const database = `outcome_ci_${randomUUID().replaceAll('-', '')}`;
    const observer = await connect(nativeUrl, 'outcome-fixture-owner');
    let db, writer, child, childResult, childDone, prefix;
    const own = new URL(nativeUrl);
    own.pathname = `/${database}`;
    const clients = [];
    const failures = [];
    const finishCleanup = async (operation) => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    };
    const waitFor = async (predicate) => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await delay(25);
      }
      throw Error('OUTCOME_NATIVE_OBSERVATION_TIMEOUT');
    };
    const launch = (selector, tag) => {
      childResult = undefined;
      child = spawn(
        process.execPath,
        [resolve(root, 'scripts/agent/outcome-cohort-online-prepare.mjs'), selector],
        {
          cwd: root,
          env: {
            ...process.env,
            DATABASE_URL: own.href,
            MAXIM_MULTIBOT_PREPARE_APPLICATION_NAME: tag,
          },
          detached: true,
          stdio: ['ignore', 'ignore', 'ignore'],
        },
      );
      childDone = new Promise((done) => {
        child.once('error', () => {
          childResult = { code: 1 };
          done(childResult);
        });
        child.once('close', (code, signal) => {
          childResult = { code, signal };
          done(childResult);
        });
      });
      return childDone;
    };
    try {
      await observer.query(`CREATE DATABASE "${database}"`);
      db = await connect(own.href, 'outcome-fixture-observer');
      clients.push(db);
      writer = await connect(own.href, 'outcome-fixture-writer');
      clients.push(writer);
      prefix = createOutcomeCohortMigrationPrefix(root, 'delete');
      // FLAG: Only disposable copied prefix files change. Every prerequisite receipt is
      // produced by the real Prisma engine; no successful receipt is fabricated as evidence.
      rmSync(resolve(prefix.tempRoot, 'migrations', OUTCOME_COHORT_TARGETS[0].migration), {
        recursive: true,
      });
      const bootstrap = spawnSync(
        process.execPath,
        [
          resolve(root, 'node_modules/prisma/build/index.js'),
          'migrate',
          'deploy',
          '--config',
          prefix.configPath,
        ],
        {
          cwd: root,
          env: { ...process.env, DATABASE_URL: own.href },
          stdio: 'ignore',
          timeout: 120_000,
        },
      );
      assert.equal(bootstrap.status, 0, 'Real prerequisite migrations must complete');
      rmSync(prefix.tempRoot, { recursive: true, force: true });
      prefix = undefined;
      const snapshot = async () => outcome(await db.query(outcomeCohortStateSql));
      assert.equal(
        verifyOutcomeCohortPreparationState(await snapshot(), source).state,
        'prepare_delete',
      );
      await db.query(`INSERT INTO chats(id,title,updated_at) VALUES ('outcome-fixture','fixture',now());
        INSERT INTO managed_broadcasts(id,source_chat_id,actor_user_id,target_chat_ids,buttons,updated_at)
          VALUES ('outcome-broadcast','outcome-fixture','fixture','[]','[]',now());
        INSERT INTO moderation_delete_intents(id,chat_id,message_id,retry_until_at,updated_at)
          SELECT 'outcome-intent-'||n,'outcome-fixture','message-'||n,now()+interval '1 day',now()
          FROM generate_series(1,100000) n;
        INSERT INTO managed_broadcast_deliveries(id,broadcast_id,occurrence_index,target_chat_id,dispatch_profile,updated_at)
          SELECT 'outcome-delivery-'||n,'outcome-broadcast',0,'target-'||n,'PUBLIK_V1',now()
          FROM generate_series(1,50000) n;
        ANALYZE moderation_delete_intents; ANALYZE managed_broadcast_deliveries;`);

      await t.test(
        'builds DELETE while a writer remains live and preserves genuine applied receipt',
        async () => {
          await writer.query(
            "BEGIN; UPDATE moderation_delete_intents SET attempt_count=1 WHERE id='outcome-intent-1'",
          );
          const tag = `maxim-online-${randomUUID()}`;
          const done = launch('delete', tag);
          await waitFor(
            async () =>
              (
                await db.query(
                  `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND application_name=$1 AND query LIKE '%CREATE INDEX CONCURRENTLY%') AS present`,
                  [tag],
                )
              ).rows[0].present,
          );
          assert.equal(childResult, undefined);
          await writer.query(
            "UPDATE moderation_delete_intents SET attempt_count=2 WHERE id='outcome-intent-2'; COMMIT",
          );
          assert.equal((await done).code, 0);
          assert.equal(
            verifyOutcomeCohortPreparationState(await snapshot(), source).state,
            'prepare_recipient',
          );
          const size = Number(
            (
              await db.query(
                `SELECT pg_relation_size('public.${OUTCOME_COHORT_TARGETS[0].index}') AS size`,
              )
            ).rows[0].size,
          );
          assert.ok(size / 100000 < OUTCOME_COHORT_TARGETS[0].estimateBytesPerRow);
        },
      );

      await t.test(
        'actual SQL session settings apply and reset around one concurrent DDL',
        async () => {
          const settings = await connect(own.href, 'outcome-fixture-settings');
          clients.push(settings);
          const sql = readFileSync(
            resolve(
              root,
              'apps/api/prisma/migrations',
              OUTCOME_COHORT_TARGETS[1].migration,
              'migration.sql',
            ),
            'utf8',
          );
          const before = sql.slice(0, sql.indexOf('CREATE INDEX CONCURRENTLY'));
          await settings.query(before);
          const row = (
            await settings.query(`SELECT current_setting('statement_timeout') AS statement,
          current_setting('lock_timeout') AS lock, current_setting('maintenance_work_mem') AS maintenance,
          current_setting('temp_file_limit') AS temp,current_setting('max_parallel_maintenance_workers') AS parallel`)
          ).rows[0];
          assert.deepEqual(row, {
            statement: '10min',
            lock: '5s',
            maintenance: '128MB',
            temp: '512MB',
            parallel: '0',
          });
          await settings.query(sql.slice(sql.indexOf('RESET temp_file_limit')));
        },
      );

      await t.test(
        'cancellation preserves invalid index and failed receipt, refuses replay, keeps foreign observer',
        async () => {
          await writer.query(
            "BEGIN; UPDATE managed_broadcast_deliveries SET attempt_count=1 WHERE id='outcome-delivery-1'",
          );
          const tag = `maxim-online-${randomUUID()}`;
          const foreign = await connect(own.href, `${tag}-observer`);
          clients.push(foreign);
          const foreignPid = (await foreign.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          const done = launch('recipient', tag);
          await waitFor(
            async () =>
              (
                await db.query(
                  `SELECT EXISTS(SELECT 1 FROM pg_index
          WHERE indexrelid=to_regclass($1) AND NOT indisvalid) AS present`,
                  [`public.${OUTCOME_COHORT_TARGETS[1].index}`],
                )
              ).rows[0].present,
          );
          const canceled = await db.query(
            `SELECT pg_cancel_backend(pid) AS canceled FROM pg_stat_activity
          WHERE datname=current_database() AND application_name=$1 AND pid<>pg_backend_pid()`,
            [tag],
          );
          assert.ok(canceled.rows.some((row) => row.canceled));
          assert.equal((await done).code, 1);
          await writer.query('COMMIT');
          const failed = await snapshot();
          const receipt = failed.receipts.find(
            (r) => r.name === OUTCOME_COHORT_TARGETS[1].migration,
          );
          assert.equal(receipt.checksum, OUTCOME_COHORT_TARGETS[1].checksum);
          assert.equal(receipt.finished, false);
          assert.equal(receipt.rolled_back, false);
          const index = failed.indexes.find((index) => index.selector === 'recipient');
          assert.equal(index.present, true);
          assert.equal(index.exact, false);
          assert.equal(index.definition_matches, true);
          assert.equal(index.valid, false);
          assert.throws(
            () => verifyOutcomeCohortPreparationState(failed, source),
            /RECEIPT_BLOCKED/u,
          );
          assert.equal((await launch('recipient', `maxim-online-${randomUUID()}`)).code, 1);
          assert.equal(
            (await foreign.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
            foreignPid,
          );
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1',
                [tag],
              )
            ).rows[0].count,
            0,
          );
        },
      );

      await t.test(
        'catalog detects changed order, include, predicate and repair artifacts',
        async () => {
          // Only this disposable database is changed; the failed receipt stays retained.
          const target = OUTCOME_COHORT_TARGETS[0];
          for (const tail of [
            '(status,created_at DESC,id)',
            '(status,created_at,id) INCLUDE (chat_id)',
            "(status,created_at,id) WHERE status='PENDING'",
          ]) {
            await db.query(`DROP INDEX public.${target.index}`);
            await db.query(`CREATE INDEX ${target.index} ON public.${target.table} ${tail}`);
            assert.equal((await snapshot()).indexes[0].exact, false);
          }
          const artifact = `${target.index.slice(0, 57)}_ccnew`;
          await db.query(`CREATE INDEX ${artifact} ON public.${target.table}(id)`);
          assert.ok((await snapshot()).artifacts.includes(artifact));
        },
      );
      await t.test(
        'state and capacity reject inherited history tables despite a valid exact index',
        async () => {
          const target = OUTCOME_COHORT_TARGETS[0];
          await db.query(`DROP INDEX public.${target.index}`);
          await db.query(
            `CREATE INDEX ${target.index} ON public.${target.table}(status,created_at,id)`,
          );
          assert.equal(
            (await snapshot()).indexes.find((index) => index.selector === 'delete').exact,
            true,
          );
          await db.query(
            `CREATE TABLE outcome_inherited_history () INHERITS(public.${target.table})`,
          );
          assert.equal(
            (await snapshot()).indexes.find((index) => index.selector === 'delete')
              .definition_matches,
            false,
          );
          const capacity = outcome(await db.query(outcomeCohortCapacitySql));
          assert.equal(capacity.tables.find((table) => table.selector === 'delete').exact, false);
        },
      );
    } catch (error) {
      failures.push(error);
    } finally {
      // FLAG: Preserve the primary failure and attempt every cleanup. Failed process
      // termination cannot block database/client cleanup by waiting for that process.
      if (child && !childResult) {
        let stopped = false;
        try {
          process.kill(-child.pid, 'SIGKILL');
          stopped = true;
        } catch (error) {
          if (error.code === 'ESRCH') stopped = true;
          else failures.push(error);
        }
        if (stopped) await finishCleanup(() => childDone);
      }
      if (prefix) {
        await finishCleanup(() => rmSync(prefix.tempRoot, { recursive: true, force: true }));
      }
      for (const client of clients.reverse()) await finishCleanup(() => client.end());
      await finishCleanup(() =>
        observer.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`),
      );
      await finishCleanup(() => observer.end());
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Outcome cohort native test and cleanup failed', {
        cause: failures[0],
      });
    }
  },
);
