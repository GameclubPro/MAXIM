import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  MIGRATION,
  recoveryAuditSql,
  recoveryIndexSql,
  verifyRecoveryState,
} from './publication-priority-recovery-schema.mjs';

export async function recoverPublicationPriority(operations, apply) {
  const read = async () => verifyRecoveryState(await operations.read(), operations.checksum);
  let state = await read();
  const summary = () => ({
    actions: state.actions,
    recordState: state.recordState,
    applied: false,
  });
  if (!apply || state.recordState === 'applied') return summary();
  const identity = state.recordIdentity;
  const assertSameRecord = (current) => {
    if (current.recordIdentity !== identity)
      throw new Error('Migration state changed during recovery.');
  };
  for (const initial of state.actions) {
    await operations.assertHealthy();
    state = await read();
    assertSameRecord(state);
    const current = state.actions.find(({ name }) => name === initial.name);
    if (current.action !== initial.action) throw new Error('Index state changed before repair.');
    if (current.action !== 'ready') {
      await operations.repair(current.name, current.action);
      state = await read();
      assertSameRecord(state);
      if (state.actions.find(({ name }) => name === current.name).action !== 'ready')
        throw new Error('Index repair postcondition failed; migration remains unresolved.');
    }
  }
  await operations.assertHealthy();
  state = await read();
  assertSameRecord(state);
  if (state.actions.some(({ action }) => action !== 'ready'))
    throw new Error('Both exact indexes must be valid before resolution.');
  await operations.resolve();
  state = await read();
  if (state.recordState !== 'applied') throw new Error('Applied migration receipt not found.');
  return { ...summary(), applied: true };
}

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    timeout: 140_000,
    maxBuffer: 128 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    const code = result.stderr?.match(/\b(55P03|57014|40P01)\b/u)?.[1];
    throw new Error(
      `Recovery command failed: ${binary}${code ? ` (${code})` : ''}. No success was recorded.`,
    );
  }
  return result.stdout.trim();
}

async function main() {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--apply'))
    throw new Error('Usage: recovery helper [--apply]');
  const appName = process.env.MAXIM_PUBLICATION_PRIORITY_RECOVERY_APP_NAME;
  if (!appName || !/^maxim-pub-priority-recovery-[0-9-]+$/u.test(appName) || appName.length > 63)
    throw new Error('Use the locked recovery wrapper.');
  const sha = command('git', ['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/u.test(sha) || process.env.MAXIM_EXPECTED_DEPLOY_SHA !== sha)
    throw new Error('Exact reviewed source SHA is required.');
  command('git', ['diff', '--quiet', 'HEAD', '--', 'infra', 'apps/api/prisma/migrations']);
  for (const file of [
    'publication-priority-migration-recovery.mjs',
    'publication-priority-recovery-schema.mjs',
    'vps-recover-publication-priority-migration.sh',
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
  const sql = (query, mutate = false) =>
    command(
      'docker',
      [
        ...compose,
        'exec',
        '-T',
        '-e',
        `PGAPPNAME=${appName}`,
        '-e',
        `PGOPTIONS=-c statement_timeout=${mutate ? '120s' : '2500ms'} -c lock_timeout=${mutate ? '30s' : '250ms'} -c default_transaction_read_only=${mutate ? 'off' : 'on'} -c idle_in_transaction_session_timeout=4s -c max_parallel_workers_per_gather=0 -c max_parallel_maintenance_workers=0 -c maintenance_work_mem=32MB -c temp_file_limit=${mutate ? '256MB' : '8MB'} -c work_mem=1MB -c search_path=pg_catalog,public`,
        'postgres',
        'psql',
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '-v',
        'VERBOSITY=sqlstate',
        '-A',
        '-t',
        '-U',
        'maxim',
        '-d',
        'maxim',
      ],
      { input: query },
    );
  const checksum = createHash('sha256')
    .update(readFileSync(`apps/api/prisma/migrations/${MIGRATION}/migration.sql`))
    .digest('hex');
  const result = await recoverPublicationPriority(
    {
      checksum,
      read: () => JSON.parse(sql(recoveryAuditSql)),
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
            throw new Error(
              'Healthy runtime and normal system mode are required for index recovery.',
            );
        }
      },
      repair: (name, action) => {
        process.stdout.write(`${action}: ${name}\n`);
        sql(recoveryIndexSql(name, action), true);
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
          throw new Error('Recovery image identity differs from the protected running image.');
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
            `com.maxim.publication-priority-recovery=${appName}`,
            '--volume',
            `${process.cwd()}/apps/api/prisma/migrations:/app/apps/api/prisma/migrations:ro`,
            '-e',
            `PGAPPNAME=${appName}`,
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
