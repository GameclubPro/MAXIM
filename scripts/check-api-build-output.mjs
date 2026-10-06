import { existsSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
const apiRoot = resolve(repoRoot, 'apps/api');
const sourceRoot = resolve(apiRoot, 'src');
const emittedSourceRoot = resolve(apiRoot, 'dist/apps/api/src');
const entrypoint = resolve(emittedSourceRoot, 'main.js');

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

if (!existsSync(entrypoint)) {
  throw new Error(`API build entrypoint is missing: ${relative(repoRoot, entrypoint)}`);
}

const staleOutputs = walk(emittedSourceRoot)
  .filter((path) => path.endsWith('.js'))
  .filter((path) => {
    const sourceRelativePath = relative(emittedSourceRoot, path).replace(/\.js$/u, '');
    return !['.ts', '.tsx', '.mts', '.cts'].some((extension) =>
      existsSync(resolve(sourceRoot, `${sourceRelativePath}${extension}`)),
    );
  })
  .map((path) => relative(apiRoot, path));

if (staleOutputs.length > 0) {
  throw new Error(`API build contains output without source:\n${staleOutputs.join('\n')}`);
}

const syntaxCheck = spawnSync(process.execPath, ['--check', entrypoint], {
  encoding: 'utf8',
});

if (syntaxCheck.status !== 0) {
  throw new Error(syntaxCheck.stderr || syntaxCheck.stdout || 'API entrypoint syntax check failed');
}

// FLAG: Prisma loads the permanent hold reader before effect services at startup.
// Check the emitted CommonJS dependency order: ts-jest's different import order
// can conceal a circular import that silently erases optional injection metadata.
const holdInjectionCheck = spawnSync(process.execPath, ['-e', `
  require('reflect-metadata');
  const path = require('node:path');
  const root = process.argv[1];
  const { WebhookLegacyHoldService } = require(path.join(root, 'webhook/webhook-legacy-hold.service.js'));
  for (const [file, name] of [
    ['max/max-client.service.js', 'MaxClientService'],
    ['common/group-command-authority.service.js', 'GroupCommandAuthorityService'],
    ['max/max-action-ledger.service.js', 'MaxActionLedgerService'],
    ['max/max-action-dispatch.service.js', 'MaxActionDispatchService'],
  ]) {
    const provider = require(path.join(root, file))[name];
    const parameters = Reflect.getMetadata('design:paramtypes', provider);
    if (!parameters?.includes(WebhookLegacyHoldService)) {
      throw new Error('Compiled mandatory hold injection is missing in ' + name);
    }
  }
`, emittedSourceRoot], { cwd: repoRoot, encoding: 'utf8', timeout: 15_000 });
if (holdInjectionCheck.status !== 0) {
  throw new Error(holdInjectionCheck.stderr || 'Compiled hold injection check failed');
}
