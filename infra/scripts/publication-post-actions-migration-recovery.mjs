import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MIGRATION = '20260909130000_add_publication_post_actions';
const INDEX = 'managed_broadcast_deliveries_post_actions_due_idx';
const ENUM = '"PublicationPostActionStatus"';
const expectedColumns = [
  ['publication_content_revisions', 'post_publish', 'jsonb', true, "'{}'::jsonb"],
  [
    'managed_broadcast_deliveries',
    'post_actions_next_at',
    'timestamp(3) without time zone',
    false,
    null,
  ],
  ['managed_broadcast_deliveries', 'post_actions_token', 'text', false, null],
  ['managed_broadcast_deliveries', 'pin_status', ENUM, true, `'NONE'::${ENUM}`],
  ['managed_broadcast_deliveries', 'pin_error', 'text', false, null],
  ['managed_broadcast_deliveries', 'pin_attempt_count', 'integer', true, '0'],
  ['managed_broadcast_deliveries', 'delete_status', ENUM, true, `'NONE'::${ENUM}`],
  ['managed_broadcast_deliveries', 'delete_at', 'timestamp(3) without time zone', false, null],
  ['managed_broadcast_deliveries', 'deleted_at', 'timestamp(3) without time zone', false, null],
  ['managed_broadcast_deliveries', 'delete_error', 'text', false, null],
  ['managed_broadcast_deliveries', 'delete_attempt_count', 'integer', true, '0'],
];

export function verifyPublicationRecoverySchema(report) {
  if (
    !Number.isSafeInteger(report?.delivery_table_bytes) ||
    report.delivery_table_bytes < 0 ||
    report.delivery_table_bytes > 512 * 1024 * 1024
  )
    throw new Error('Delivery table exceeds the bounded online-recovery scope.');
  if (
    report?.audit !== 'publication_post_actions_schema' ||
    report.migration !== MIGRATION ||
    report.parents_present !== true ||
    report.repair_artifacts !== false ||
    JSON.stringify(report.enum_labels) !==
      JSON.stringify(['NONE', 'PENDING', 'RUNNING', 'DONE', 'FAILED', 'AMBIGUOUS', 'SKIPPED']) ||
    report.columns?.length !== expectedColumns.length
  )
    throw new Error('Schema does not match the fixed recovery scope.');
  for (const [table, column, type, notNull, defaultValue] of expectedColumns) {
    const actual = report.columns.filter((item) => item.table === table && item.column === column);
    if (
      actual.length !== 1 ||
      actual[0].present !== true ||
      actual[0].type !== type ||
      actual[0].not_null !== notNull ||
      actual[0].default !== defaultValue
    )
      throw new Error('Recovery requires every additive column with its exact type and default.');
  }
  const index = report.index;
  if (
    !index ||
    index.ready !== true ||
    typeof index.valid !== 'boolean' ||
    index.unique !== false ||
    index.method !== 'btree' ||
    index.attributes !== 4 ||
    index.keys !== 4 ||
    index.predicate !== null ||
    index.expressions !== null ||
    JSON.stringify(index.columns) !==
      JSON.stringify(['dispatch_profile', 'status', 'post_actions_next_at', 'id'])
  )
    throw new Error('Index definition is outside the fixed recovery scope.');
  return index.valid ? 'ready' : 'reindex';
}

export function verifyPublicationRecoveryRecord(report, checksum) {
  if (!report || report.oversized !== false || report.records?.length !== 1)
    throw new Error('Expected exactly one active migration record in bounded metadata.');
  const record = report.records[0];
  if (record.checksum !== checksum)
    throw new Error('Migration checksum differs from the immutable source.');
  if (record.finished === true) return 'applied';
  if (record.finished !== false || record.lock_timeout !== true)
    throw new Error("Only this migration's lock-timeout failure is recoverable.");
  return 'failed';
}

export async function recoverPublicationMigration(operations, apply) {
  const schemaState = verifyPublicationRecoverySchema(await operations.readSchema());
  const recordState = verifyPublicationRecoveryRecord(
    await operations.readRecord(),
    operations.checksum,
  );
  if (recordState === 'applied' && schemaState !== 'ready')
    throw new Error('Applied migration has schema drift; recovery refused.');
  if (!apply || recordState === 'applied') return { schemaState, recordState, applied: false };
  await operations.assertHealthy();
  if (schemaState === 'reindex') await operations.reindex();
  if (verifyPublicationRecoverySchema(await operations.readSchema()) !== 'ready')
    throw new Error('Reindex did not produce the required valid index.');
  if (
    verifyPublicationRecoveryRecord(await operations.readRecord(), operations.checksum) !== 'failed'
  )
    throw new Error('Migration state changed during recovery.');
  await operations.resolve();
  if (
    verifyPublicationRecoverySchema(await operations.readSchema()) !== 'ready' ||
    verifyPublicationRecoveryRecord(await operations.readRecord(), operations.checksum) !==
      'applied'
  )
    throw new Error('Recovery postconditions failed; normal deploy remains blocked.');
  return { schemaState: 'ready', recordState: 'applied', applied: true };
}

// FLAG: No caller-supplied SQL. These operations address only schema metadata and one fixed index.
export const publicationRecoveryRecordSql = `SELECT json_build_object(
  'oversized', pg_relation_size('public._prisma_migrations') > 8388608,
  'records', CASE WHEN pg_relation_size('public._prisma_migrations') <= 8388608 THEN (
    SELECT COALESCE(json_agg(x), '[]'::json) FROM (
      SELECT checksum, finished_at IS NOT NULL AS finished,
        COALESCE(logs LIKE '%55P03%' OR logs LIKE '%lock timeout%', false) AS lock_timeout
      FROM public._prisma_migrations
      WHERE migration_name = '${MIGRATION}' AND rolled_back_at IS NULL LIMIT 2
    ) x
  ) ELSE '[]'::json END);`;
export const publicationRecoveryReindexSql = `REINDEX INDEX CONCURRENTLY public.${INDEX};`;

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    timeout: 150_000,
    maxBuffer: 128 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(`Recovery command failed: ${binary}. No success state was recorded.`);
  return result.stdout.trim();
}

async function main() {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--apply'))
    throw new Error('Usage: recovery helper [--apply]');
  const appName = process.env.MAXIM_PUBLICATION_RECOVERY_APP_NAME;
  if (!appName || !/^maxim-publication-recovery-[0-9-]+$/u.test(appName) || appName.length > 63)
    throw new Error('Use the locked recovery wrapper.');
  const sha = command('git', ['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/u.test(sha) || process.env.MAXIM_EXPECTED_DEPLOY_SHA !== sha)
    throw new Error('Exact reviewed source SHA is required.');
  command('git', ['diff', '--quiet', 'HEAD', '--', 'infra', 'apps/api/prisma/migrations']);
  for (const file of [
    'publication-post-actions-migration-recovery.mjs',
    'publication-post-actions-schema-audit.mjs',
    'vps-recover-publication-post-actions-migration.sh',
  ]) {
    command('git', ['cat-file', '-e', `HEAD:infra/scripts/${file}`]);
  }
  const compose = [
    'compose',
    '--env-file',
    '.env',
    '-p',
    'infra',
    '-f',
    'infra/docker-compose.yml',
  ];
  const readSql = (sql, mutate = false) =>
    command(
      'docker',
      [
        ...compose,
        'exec',
        '-T',
        '-e',
        `PGAPPNAME=${appName}`,
        '-e',
        `PGOPTIONS=-c statement_timeout=${mutate ? '120s' : '2500ms'} -c lock_timeout=${mutate ? '30s' : '250ms'} -c default_transaction_read_only=${mutate ? 'off' : 'on'} -c max_parallel_workers_per_gather=0 -c max_parallel_maintenance_workers=0 -c maintenance_work_mem=32MB -c temp_file_limit=${mutate ? '256MB' : '8MB'} -c work_mem=1MB -c search_path=pg_catalog,public`,
        'postgres',
        'psql',
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '-A',
        '-t',
        '-U',
        'maxim',
        '-d',
        'maxim',
      ],
      { input: sql },
    );
  const checksum = createHash('sha256')
    .update(readFileSync(`apps/api/prisma/migrations/${MIGRATION}/migration.sql`))
    .digest('hex');
  const result = await recoverPublicationMigration(
    {
      checksum,
      readSchema: () =>
        JSON.parse(command('bash', ['infra/scripts/vps-postgres-audit.sh', 'publication-schema'])),
      readRecord: () => JSON.parse(readSql(publicationRecoveryRecordSql)),
      assertHealthy: () => {
        for (const port of [3001, 3002]) {
          const health = JSON.parse(
            command('curl', [
              '-fsS',
              '--max-time',
              '10',
              `http://127.0.0.1:${port}/api/health/ready`,
            ]),
          );
          if (
            health.ok !== true ||
            health.checks?.queueLag?.rawOk !== true ||
            health.systemMode?.mode !== 'normal'
          )
            throw new Error('Stable healthy runtime is required for index recovery.');
        }
      },
      reindex: () => {
        process.stdout.write('Rebuilding the fixed invalid index concurrently.\n');
        readSql(publicationRecoveryReindexSql, true);
      },
      resolve: () => {
        const container = command('docker', [...compose, 'ps', '-q', 'api-ingress']);
        if (!/^[a-f0-9]{12,64}$/u.test(container))
          throw new Error('Expected one running ingress container.');
        const image = command('docker', ['inspect', '--format', '{{.Config.Image}}', container]);
        if (!/^maxim-api:[a-f0-9]{40}$/u.test(image))
          throw new Error('Recovery requires a retained immutable API image.');
        const sourceSha = image.slice('maxim-api:'.length);
        if (
          command('docker', [
            'image',
            'inspect',
            '--format',
            '{{index .Config.Labels "org.opencontainers.image.revision"}}',
            image,
          ]) !== sourceSha ||
          command('docker', ['inspect', '--format', '{{.Image}}', container]) !==
            command('docker', ['image', 'inspect', '--format', '{{.Id}}', image])
        ) {
          throw new Error('Recovery image identity differs from the running immutable source.');
        }
        if (
          command('docker', [
            'image',
            'inspect',
            '--format',
            '{{index .Config.Labels "com.maxim.release-protected"}}',
            image,
          ]) !== 'true'
        )
          throw new Error('Recovery image is not release-protected.');
        command(
          'docker',
          [
            ...compose,
            '-f',
            'infra/docker-compose.runtime-no-build.yml',
            'run',
            '--rm',
            '--no-deps',
            '--pull',
            'never',
            '--name',
            appName,
            '--label',
            `com.maxim.publication-migration-recovery=${appName}`,
            '--volume',
            `${process.cwd()}/apps/api/prisma/migrations:/app/apps/api/prisma/migrations:ro`,
            'api-ingress',
            './node_modules/.bin/prisma',
            'migrate',
            'resolve',
            '--applied',
            MIGRATION,
            '--config',
            'apps/api/prisma.config.ts',
          ],
          { env: { ...process.env, MAXIM_MIGRATION_API_IMAGE: image } },
        );
      },
    },
    process.argv[2] === '--apply',
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
