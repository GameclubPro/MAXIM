import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const source = readFileSync(new URL('../lib/deploy-lock.sh', import.meta.url), 'utf8');

// FLAG: Production has no lock-path override. Tests execute the real helper with
// only its two fixed paths relocated into an owned, isolated temporary fixture.
export function deployLockFixture(directory, helper = resolve(directory, 'deploy-lock.sh')) {
  const protectedDirectory = resolve(directory, 'protected');
  const legacyDirectory = resolve(directory, 'legacy-lock');
  mkdirSync(protectedDirectory, { mode: 0o700 });
  mkdirSync(dirname(helper), { recursive: true });
  writeFileSync(
    helper,
    source
      .replaceAll('/var/lib/maxim-deploy', protectedDirectory)
      .replaceAll('/tmp/maxim-main-deploy.lock', legacyDirectory),
  );
  return {
    helper,
    protectedDirectory,
    legacyDirectory,
    file: resolve(protectedDirectory, 'deploy.lock'),
  };
}

export function deployLockEnvironment(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('MAXIM_DEPLOY_LOCK_')) delete env[key];
  }
  return { ...env, ...extra };
}
