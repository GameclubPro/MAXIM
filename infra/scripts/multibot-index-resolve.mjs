import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createMultibotPrepareEnvironment } from '../../scripts/agent/multibot-online-prepare.mjs';

// FLAG: Resolve only the proven index migration. The URL tag makes even Prisma's
// URI-driven connections exclusively cancellable by this recovery attempt.
export function resolveMultibotIndexReceipt(env, run = spawnSync) {
  if (!env.MAXIM_MULTIBOT_PREPARE_APPLICATION_NAME)
    throw new Error('MULTIBOT_RECOVERY_APPLICATION_INVALID');
  const tagged = createMultibotPrepareEnvironment(env);
  const result = run(
    process.execPath,
    [
      '/app/node_modules/prisma/build/index.js',
      'migrate',
      'resolve',
      '--applied',
      '20261005016100_index_multibot_retention_cursor',
      '--config',
      'apps/api/prisma.config.ts',
    ],
    { env: tagged, encoding: 'utf8', timeout: 90_000, maxBuffer: 64 * 1024 },
  );
  if (result.error || result.signal || result.status !== 0)
    throw new Error('MULTIBOT_RECOVERY_RESOLVE_COMMAND_FAILED');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw new Error('MULTIBOT_RECOVERY_ARGUMENTS_INVALID');
    resolveMultibotIndexReceipt(process.env);
    console.log('Fixed index migration receipt resolved.');
  } catch {
    console.error('MULTIBOT_RECOVERY_RESOLVE_COMMAND_FAILED');
    process.exitCode = 1;
  }
}
