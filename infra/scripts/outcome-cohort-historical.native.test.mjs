import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
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

const root = resolve(import.meta.dirname, '../..');
const nativeUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim();
const source = readOutcomeCohortSource(root);
const fixtureDirectory = resolve(import.meta.dirname, 'fixtures/outcome-cohort-history');
// The first two SQL files are recovered from commits 5e5b3ef3f249838915805ec267963b39c18da197
// and f01eca24604f1bbd09ad5bd8313e86a13f82d7b9. The two missing night migrations are
// reconstructed bytes matching the applied checksums; no original commit is claimed.
const historical = [
  [
    '20260301143000_add_commercial_scoring_settings',
    'bf0f08ea91e490406c5f04fe78895bdacd41eb2a475054b4b509390126068c99',
  ],
  [
    '20260301173000_add_delete_bots_messages_toggle',
    'e2be732e2c92320c22f82d89d827479532e256039ceb97e7316e200c983ee55e',
  ],
  [
    '20260311153000_add_night_mode_open_message_enabled',
    '6327681695854247dfe8d06a42f917ed6d2af9a61fce10cdff718446219c072b',
  ],
  [
    '20260311160000_add_night_mode_open_message_text',
    '65b381f01dcd3e2870c9290118941d8ee88f977c67232ba31332d730e9c9dc2b',
  ],
];
const replacement = '20260316113000_add_night_mode_open_message';
const outcome = (result) =>
  (Array.isArray(result) ? result : [result])
    .flatMap((part) => part.rows)
    .find((row) => row?.json_build_object)?.json_build_object;

test(
  'genuine historical receipts converge in an empty disposable fixture and permit only two online migrations',
  { skip: !nativeUrl, timeout: 240_000 },
  async (t) => {
    const base = new URL(nativeUrl);
    assert.ok(
      ['postgres:', 'postgresql:'].includes(base.protocol) &&
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
        options: '-c statement_timeout=15000 -c lock_timeout=1000 -c timezone=UTC',
      });
      client.on('error', () => {});
      await client.connect();
      return client;
    };
    const database = `outcome_history_ci_${randomUUID().replaceAll('-', '')}`;
    assert.match(database, /^outcome_history_ci_[a-f0-9]{32}$/u);
    const own = new URL(nativeUrl);
    own.pathname = `/${database}`;
    const owner = await connect(nativeUrl, 'outcome-history-fixture-owner');
    let db, prefix;
    const failures = [];
    const finishCleanup = async (operation) => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    };
    const runNode = (args, label, additionalEnv = {}) => {
      const result = spawnSync(process.execPath, args, {
        cwd: root,
        env: { ...process.env, DATABASE_URL: own.href, ...additionalEnv },
        stdio: 'ignore',
        timeout: 120_000,
        killSignal: 'SIGKILL',
      });
      assert.equal(result.error, undefined, label);
      assert.equal(result.signal, null, label);
      assert.equal(result.status, 0, label);
    };
    const runPrerequisites = () =>
      runNode(
        [
          resolve(root, 'node_modules/prisma/build/index.js'),
          'migrate',
          'deploy',
          '--config',
          prefix.configPath,
        ],
        'The genuine Prisma engine must apply the disposable prerequisite prefix',
      );
    const snapshot = async () => outcome(await db.query(outcomeCohortStateSql));
    // Read every immutable receipt field, retaining microsecond timestamps as text.
    const receipts = async () =>
      (
        await db.query(`SELECT id, migration_name AS name, checksum,
        started_at::text AS started_at, finished_at::text AS finished_at,
        rolled_back_at::text AS rolled_back_at, applied_steps_count AS steps, logs
        FROM public._prisma_migrations ORDER BY migration_name,id`)
      ).rows;
    const historicalReceipts = (rows) =>
      rows.filter((row) => historical.some(([name]) => name === row.name));
    const assertHistoricalReceipts = (rows) => {
      assert.equal(rows.length, historical.length);
      for (const [name, checksum] of historical) {
        const matching = rows.filter((row) => row.name === name);
        assert.equal(matching.length, 1);
        assert.equal(matching[0].checksum, checksum);
        assert.equal(matching[0].steps, 1);
        assert.ok(matching[0].started_at);
        assert.ok(matching[0].finished_at);
        assert.equal(matching[0].rolled_back_at, null);
        assert.equal(matching[0].logs, null);
      }
    };
    const assertCatalogProof = (state) => {
      assert.deepEqual(
        [...state.historicalCompatibility].sort((a, b) => a.name.localeCompare(b.name)),
        historical.map(([name]) => ({ name, exact: true })),
      );
    };
    try {
      await owner.query(`CREATE DATABASE "${database}"`);
      db = await connect(own.href, 'outcome-history-fixture-observer');
      prefix = createOutcomeCohortMigrationPrefix(root, 'delete');
      const migrationDirectory = resolve(prefix.tempRoot, 'migrations');
      const earlyCutoff = historical.at(-1)[0];
      // FLAG: Only copied temporary SQL changes. Prisma creates every receipt itself;
      // this fixture never writes receipt rows or uses migrate resolve.
      for (const name of prefix.migrationNames) {
        if (name > earlyCutoff) rmSync(resolve(migrationDirectory, name), { recursive: true });
      }
      for (const [name, checksum] of historical) {
        const file = resolve(fixtureDirectory, `${name}.sql`);
        assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), checksum);
        mkdirSync(resolve(migrationDirectory, name), { recursive: true });
        cpSync(file, resolve(migrationDirectory, name, 'migration.sql'));
      }
      runPrerequisites();
      const originalReceipts = historicalReceipts(await receipts());
      assertHistoricalReceipts(originalReceipts);

      // FLAG: This is an empty disposable convergence fixture, not a reconstruction
      // of production history. Prove local owned database identity and no settings
      // rows before DDL. Receipts remain untouched while the later genuine replacement
      // receives its own receipt after the fixture-only removal of the old columns.
      await db.query('BEGIN');
      try {
        const identity = (
          await db.query(`SELECT current_database() AS database,
          NOT EXISTS (SELECT 1 FROM public.chat_settings) AS empty`)
        ).rows[0];
        assert.equal(identity.database, database);
        assert.equal(identity.empty, true, 'No user settings may exist before fixture-only DROP');
        await db.query(
          readFileSync(
            resolve(root, 'apps/api/prisma/migrations', historical[1][0], 'migration.sql'),
            'utf8',
          ),
        );
        await db.query(`ALTER TABLE public.chat_settings
          DROP COLUMN night_mode_open_message_enabled,
          DROP COLUMN night_mode_open_message_text`);
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
      for (const { name } of source) {
        if (name > earlyCutoff && name < OUTCOME_COHORT_TARGETS[0].migration)
          cpSync(
            resolve(root, 'apps/api/prisma/migrations', name),
            resolve(migrationDirectory, name),
            { recursive: true },
          );
      }
      runPrerequisites();
      rmSync(prefix.tempRoot, { recursive: true, force: true });
      prefix = undefined;

      const before = await receipts();
      assert.deepEqual(historicalReceipts(before), originalReceipts);
      const replacementReceipts = before.filter((row) => row.name === replacement);
      assert.equal(replacementReceipts.length, 1);
      assert.equal(
        replacementReceipts[0].checksum,
        '466d063dcb6ffcb85fa4d5f6eb6dd305bd4a2cd9b0203a5885b4bd9dd19fcbce',
      );
      assert.equal(replacementReceipts[0].steps, 1);
      assert.ok(replacementReceipts[0].finished_at);
      assert.equal(replacementReceipts[0].rolled_back_at, null);
      assert.equal(replacementReceipts[0].logs, null);
      const ready = await snapshot();
      assertCatalogProof(ready);
      assert.deepEqual(verifyOutcomeCohortPreparationState(ready, source), {
        state: 'prepare_delete',
        pending: ['delete', 'recipient'],
      });

      await t.test(
        'live catalog drift blocks the historical exception without changing receipts',
        async () => {
          const driftCases = [
            [
              'commercial table reappears',
              historical[0][0],
              'CREATE TABLE public.chat_commercial_allowlist (chat_id text)',
              'DROP TABLE public.chat_commercial_allowlist',
            ],
            [
              'commercial threshold default changes',
              historical[0][0],
              'ALTER TABLE public.chat_settings ALTER COLUMN commercial_ads_warn_threshold SET DEFAULT 999',
              'ALTER TABLE public.chat_settings ALTER COLUMN commercial_ads_warn_threshold SET DEFAULT 45',
            ],
            [
              'remove-bots nullability changes',
              historical[1][0],
              'ALTER TABLE public.chat_settings ALTER COLUMN remove_bots_from_group_enabled DROP NOT NULL',
              'ALTER TABLE public.chat_settings ALTER COLUMN remove_bots_from_group_enabled SET NOT NULL',
            ],
            [
              'present optional legacy toggle has a changed default',
              historical[1][0],
              'ALTER TABLE public.chat_settings ALTER COLUMN delete_bots_messages_enabled SET DEFAULT true',
              'ALTER TABLE public.chat_settings ALTER COLUMN delete_bots_messages_enabled SET DEFAULT false',
            ],
            [
              'night enabled default changes',
              historical[2][0],
              'ALTER TABLE public.chat_settings ALTER COLUMN night_mode_open_message_enabled SET DEFAULT true',
              'ALTER TABLE public.chat_settings ALTER COLUMN night_mode_open_message_enabled SET DEFAULT false',
            ],
            [
              'night text default changes',
              historical[3][0],
              "ALTER TABLE public.chat_settings ALTER COLUMN night_mode_open_message_text SET DEFAULT 'fixture drift'",
              "ALTER TABLE public.chat_settings ALTER COLUMN night_mode_open_message_text SET DEFAULT ''",
            ],
            // FLAG: Preserve the original column and its trigger bindings. Only the
            // empty disposable fixture gets a wrong-type column at the expected name.
            [
              'night text has the wrong type with the same empty default value',
              historical[3][0],
              `ALTER TABLE public.chat_settings
                 RENAME COLUMN night_mode_open_message_text TO fixture_original_night_text;
               ALTER TABLE public.chat_settings
                 ADD COLUMN night_mode_open_message_text VARCHAR NOT NULL DEFAULT ''`,
              `ALTER TABLE public.chat_settings DROP COLUMN night_mode_open_message_text;
               ALTER TABLE public.chat_settings
                 RENAME COLUMN fixture_original_night_text TO night_mode_open_message_text`,
            ],
            [
              'required night text column is absent',
              historical[3][0],
              'ALTER TABLE public.chat_settings RENAME COLUMN night_mode_open_message_text TO fixture_missing_night_text',
              'ALTER TABLE public.chat_settings RENAME COLUMN fixture_missing_night_text TO night_mode_open_message_text',
            ],
          ];
          for (const [label, name, change, restore] of driftCases) {
            await db.query(change);
            try {
              const drifted = await snapshot();
              assert.equal(
                drifted.historicalCompatibility.find((entry) => entry.name === name).exact,
                false,
                label,
              );
              assert.throws(
                () => verifyOutcomeCohortPreparationState(drifted, source),
                /RECEIPT_BLOCKED/u,
                label,
              );
            } finally {
              await db.query(restore);
            }
          }
          assert.deepEqual(await receipts(), before);
          assertCatalogProof(await snapshot());
        },
      );

      await t.test('absence of the optional legacy toggle preserves compatibility', async () => {
        await db.query(`ALTER TABLE public.chat_settings
          RENAME COLUMN delete_bots_messages_enabled TO fixture_legacy_delete_toggle`);
        try {
          const withoutLegacy = await snapshot();
          assertCatalogProof(withoutLegacy);
          assert.deepEqual(verifyOutcomeCohortPreparationState(withoutLegacy, source), {
            state: 'prepare_delete',
            pending: ['delete', 'recipient'],
          });
          assert.deepEqual(await receipts(), before);
        } finally {
          await db.query(`ALTER TABLE public.chat_settings
            RENAME COLUMN fixture_legacy_delete_toggle TO delete_bots_messages_enabled`);
        }
      });

      await t.test(
        'shared host/image entrypoint adds only the two exact target receipts',
        async () => {
          for (const target of OUTCOME_COHORT_TARGETS) {
            // This is the same fixed Node entrypoint used by the real-image launcher;
            // container isolation remains covered by the separate image smoke suite.
            runNode(
              [resolve(root, 'scripts/agent/outcome-cohort-online-prepare.mjs'), target.selector],
              `Normal ${target.selector} preparation must accept proven historical compatibility`,
              {
                MAXIM_MULTIBOT_PREPARE_APPLICATION_NAME: `maxim-online-${randomUUID()}`,
              },
            );
          }
          const after = await receipts();
          const previousIds = new Set(before.map((row) => row.id));
          assert.deepEqual(
            after.filter((row) => previousIds.has(row.id)),
            before,
          );
          assert.deepEqual(historicalReceipts(after), originalReceipts);
          const added = after.filter((row) => !previousIds.has(row.id));
          assert.equal(added.length, OUTCOME_COHORT_TARGETS.length);
          assert.deepEqual(
            added.map(({ name }) => name),
            OUTCOME_COHORT_TARGETS.map((target) => target.migration),
          );
          for (const target of OUTCOME_COHORT_TARGETS) {
            const receipt = added.find((row) => row.name === target.migration);
            assert.equal(receipt.checksum, target.checksum);
            assert.equal(receipt.steps, 1);
            assert.ok(receipt.finished_at);
            assert.equal(receipt.rolled_back_at, null);
            assert.equal(receipt.logs, null);
          }
          const complete = await snapshot();
          assertCatalogProof(complete);
          assert.deepEqual(verifyOutcomeCohortPreparationState(complete, source), {
            state: 'already_applied',
            pending: [],
          });
          assert.equal(
            complete.indexes.every((index) => index.exact),
            true,
          );
        },
      );

      await t.test(
        'an extra enum label blocks compatibility even after both indexes exist',
        async () => {
          const settledReceipts = await receipts();
          // FLAG: This final drift is deliberately left only in the owned disposable
          // database for teardown; no enum or migration history repair is attempted.
          await db.query(`ALTER TYPE public."CommercialAdsSensitivity" ADD VALUE 'FIXTURE_DRIFT'`);
          const drifted = await snapshot();
          assert.equal(
            drifted.historicalCompatibility.find((entry) => entry.name === historical[0][0]).exact,
            false,
          );
          assert.throws(
            () => verifyOutcomeCohortPreparationState(drifted, source),
            /RECEIPT_BLOCKED/u,
          );
          assert.equal(
            drifted.indexes.every((index) => index.exact),
            true,
          );
          assert.deepEqual(await receipts(), settledReceipts);
        },
      );
    } catch (error) {
      failures.push(error);
    } finally {
      // FLAG: Keep the primary failure and attempt all cleanup only for this owned
      // disposable database and copied prefix; no production or shared store is touched.
      if (prefix)
        await finishCleanup(() => rmSync(prefix.tempRoot, { recursive: true, force: true }));
      if (db) await finishCleanup(() => db.end());
      await finishCleanup(() => owner.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`));
      await finishCleanup(() => owner.end());
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, 'Outcome historical fixture and cleanup failed', {
        cause: failures[0],
      });
  },
);
