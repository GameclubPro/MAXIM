import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MIGRATION = '20260925120000_add_suggestion_subscription';
const columns = [
  ['channel_settings', 'post_suggestions_require_subscription'],
  ['channel_settings', 'post_suggestions_delete_on_unsubscribe'],
  ['publisher_entity_settings', 'channel_suggestions_require_subscription'],
  ['publisher_entity_settings', 'channel_suggestions_delete_on_unsubscribe'],
  ['managed_broadcast_deliveries', 'subscription_delete_id'],
  ['moderation_delete_intents', 'suggestion_subscription_id'],
];
const relations = [
  'suggestion_subscription_watches',
  'suggestion_subscription_publications',
  'suggestion_subscription_watches_pkey',
  'suggestion_subscription_publications_pkey',
  'suggestion_subscription_watch_owner_key',
  'suggestion_subscription_watch_due_idx',
  'suggestion_subscription_publications_watch_idx',
  'suggestion_subscription_publications_publication_idx',
];

// FLAG: Fixed catalog/Prisma metadata only. No caller-supplied SQL and no application-row reads.
export const recoveryAuditSql = `WITH expected_columns(table_name, column_name) AS (
  VALUES ${columns.map(([table, column]) => `('${table}', '${column}')`).join(', ')}
)
SELECT json_build_object(
  'migration', '${MIGRATION}',
  'parents_present', (
    SELECT count(*) = 4 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND c.relname IN ('channel_settings', 'publisher_entity_settings', 'managed_broadcast_deliveries', 'moderation_delete_intents')
  ),
  'columns_present', (
    SELECT count(*) FROM expected_columns e
    JOIN pg_namespace n ON n.nspname = 'public'
    JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = e.table_name
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = e.column_name
    WHERE a.attnum > 0 AND NOT a.attisdropped
  ),
  'relations_present', (
    SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname IN (${relations.map((name) => `'${name}'`).join(', ')})
  ),
  'types_present', (
    SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname IN ('suggestion_subscription_watches', 'suggestion_subscription_publications')
  ),
  'metadata', CASE WHEN pg_relation_size('public._prisma_migrations') <= 8388608 THEN (
    SELECT json_build_object(
      'other_failed', EXISTS (
        SELECT 1 FROM public._prisma_migrations
        WHERE migration_name <> '${MIGRATION}' AND finished_at IS NULL AND rolled_back_at IS NULL
      ),
      'rolled_back_count', (SELECT count(*) FROM public._prisma_migrations WHERE migration_name = '${MIGRATION}' AND rolled_back_at IS NOT NULL),
      'records', (SELECT COALESCE(json_agg(x), '[]'::json) FROM (
        SELECT id, checksum, finished_at IS NOT NULL AS finished, applied_steps_count,
          CASE
            WHEN logs LIKE '%55P03%' OR logs LIKE '%lock timeout%' THEN 'lock_timeout'
            WHEN logs LIKE '%57014%' OR logs LIKE '%statement timeout%' THEN 'statement_timeout'
            WHEN logs LIKE '%40P01%' THEN 'deadlock'
            ELSE 'other'
          END AS failure
        FROM public._prisma_migrations
        WHERE migration_name = '${MIGRATION}' AND rolled_back_at IS NULL
        ORDER BY id LIMIT 2
      ) x)
    )
  ) ELSE NULL END
);`;

export function verifyRecoveryState(report, checksum) {
  if (
    report?.migration !== MIGRATION ||
    report.parents_present !== true ||
    report.columns_present !== 0 ||
    report.relations_present !== 0 ||
    report.types_present !== 0
  )
    throw new Error(
      'Recovery requires every additive object to be absent; partial schema is not repaired.',
    );
  const metadata = report.metadata;
  if (
    !metadata ||
    metadata.other_failed !== false ||
    !Number.isSafeInteger(metadata.rolled_back_count) ||
    metadata.rolled_back_count < 0 ||
    !Array.isArray(metadata.records)
  )
    throw new Error(
      'Migration metadata is oversized, invalid, or contains another failed migration.',
    );
  if (metadata.records.length === 0 && metadata.rolled_back_count > 0) return 'retry-ready';
  const record = metadata.records[0];
  if (
    metadata.records.length !== 1 ||
    typeof record.id !== 'string' ||
    !record.id ||
    record.checksum !== checksum ||
    record.finished !== false ||
    record.applied_steps_count !== 0 ||
    !['lock_timeout', 'statement_timeout', 'deadlock'].includes(record.failure)
  )
    throw new Error('Expected one checksum-matching, zero-step lock/timeout failure.');
  return 'failed';
}

export async function recoverSuggestionMigration(operations, apply) {
  const before = await operations.read();
  const state = verifyRecoveryState(before, operations.checksum);
  if (!apply || state === 'retry-ready') return { state, applied: false };
  await operations.assertHealthy();
  const confirmed = await operations.read();
  if (
    verifyRecoveryState(confirmed, operations.checksum) !== state ||
    JSON.stringify(confirmed) !== JSON.stringify(before)
  )
    throw new Error('Migration metadata changed during recovery.');
  await operations.resolve();
  const after = await operations.read();
  if (
    verifyRecoveryState(after, operations.checksum) !== 'retry-ready' ||
    after.metadata.rolled_back_count !== before.metadata.rolled_back_count + 1
  )
    throw new Error('Recovery receipt is invalid; deployment must remain blocked.');
  return { state: 'retry-ready', applied: true };
}

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    timeout: 30_000,
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
  const appName = process.env.MAXIM_SUGGESTION_RECOVERY_APP_NAME;
  if (!appName || !/^maxim-suggestion-recovery-[0-9-]+$/u.test(appName) || appName.length > 63)
    throw new Error('Use the locked recovery wrapper.');
  const sha = command('git', ['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/u.test(sha) || sha !== process.env.MAXIM_EXPECTED_DEPLOY_SHA)
    throw new Error('Exact reviewed source SHA is required.');
  command('git', ['diff', '--quiet', 'HEAD', '--', 'infra', 'apps/api/prisma/migrations']);
  for (const file of [
    'suggestion-subscription-migration-recovery.mjs',
    'vps-recover-suggestion-subscription-migration.sh',
  ])
    command('git', ['cat-file', '-e', `HEAD:infra/scripts/${file}`]);
  const compose = [
    'compose',
    '--env-file',
    '.env',
    '-p',
    'infra',
    '-f',
    'infra/docker-compose.yml',
  ];
  const read = () =>
    JSON.parse(
      command(
        'docker',
        [
          ...compose,
          'exec',
          '-T',
          '-e',
          `PGAPPNAME=${appName}`,
          '-e',
          'PGOPTIONS=-c statement_timeout=2500ms -c lock_timeout=250ms -c default_transaction_read_only=on -c idle_in_transaction_session_timeout=4s -c max_parallel_workers_per_gather=0 -c temp_file_limit=8MB -c work_mem=1MB -c search_path=pg_catalog,public',
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
        { input: recoveryAuditSql },
      ),
    );
  const checksum = createHash('sha256')
    .update(readFileSync(`apps/api/prisma/migrations/${MIGRATION}/migration.sql`))
    .digest('hex');
  const result = await recoverSuggestionMigration(
    {
      checksum,
      read: () => {
        const report = read();
        process.stdout.write(`${JSON.stringify(report)}\n`);
        return report;
      },
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
            throw new Error('Healthy runtime is required before resetting a migration attempt.');
        }
      },
      resolve: () => {
        const container = command('docker', [...compose, 'ps', '-q', 'api-ingress']);
        if (!/^[a-f0-9]{12,64}$/u.test(container))
          throw new Error('Expected one running ingress container.');
        const image = command('docker', ['inspect', '--format', '{{.Config.Image}}', container]);
        if (!/^maxim-api:[a-f0-9]{40}$/u.test(image))
          throw new Error('A retained immutable API image is required.');
        if (
          command('docker', [
            'image',
            'inspect',
            '--format',
            '{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "com.maxim.release-protected"}}',
            image,
          ]) !== `${image.slice('maxim-api:'.length)}|true` ||
          command('docker', ['inspect', '--format', '{{.Image}}', container]) !==
            command('docker', ['image', 'inspect', '--format', '{{.Id}}', image])
        )
          throw new Error('Recovery image identity differs from the running immutable source.');
        // FLAG: Only a fully absent migration may be marked rolled back. Never resolve it as applied.
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
            `com.maxim.suggestion-migration-recovery=${appName}`,
            '--volume',
            `${process.cwd()}/apps/api/prisma/migrations:/app/apps/api/prisma/migrations:ro`,
            '-e',
            `PGAPPNAME=${appName}`,
            'api-ingress',
            './node_modules/.bin/prisma',
            'migrate',
            'resolve',
            '--rolled-back',
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
