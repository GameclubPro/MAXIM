import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { contractsSourceAliases } from './vite-contracts-source.mjs';
import { getFileInfo } from 'prettier';

const root = resolve(import.meta.dirname, '..');

test('dev aliases resolve all and only public contract exports to TypeScript source', () => {
  const manifest = JSON.parse(
    readFileSync(resolve(root, 'packages/contracts/package.json'), 'utf8'),
  );
  const aliases = contractsSourceAliases(root, 'serve');
  assert.equal(aliases.length, Object.keys(manifest.exports).length);
  for (const key of Object.keys(manifest.exports)) {
    const specifier = key === '.' ? '@maxim/contracts' : `@maxim/contracts/${key.slice(2)}`;
    const matches = aliases.filter(({ find }) => find.test(specifier));
    assert.equal(matches.length, 1, specifier);
    assert.ok(matches[0].replacement.endsWith(`/src/${key === '.' ? 'index' : key.slice(2)}.ts`));
  }
  assert.equal(
    aliases.some(({ find }) => find.test('@maxim/contracts/internal')),
    false,
  );
  assert.deepEqual(contractsSourceAliases('/absent-production-sources', 'build'), []);
});

test('both Vite consumers use source aliases only during serve', () => {
  for (const app of ['miniapp', 'admin']) {
    const source = readFileSync(resolve(root, `apps/${app}/vite.config.ts`), 'utf8');
    assert.match(source, /contractsSourceAliases\(.+, command\)/u);
  }
  const dockerfile = readFileSync(resolve(root, 'apps/admin/Dockerfile'), 'utf8');
  assert.match(
    dockerfile,
    /COPY scripts\/vite-contracts-source\.mjs scripts\/vite-contracts-source\.mjs/u,
  );
});

test('formatter skips byte-exact generated output but still owns ordinary sources', async () => {
  const ignorePath = resolve(root, '.prettierignore');
  for (const file of [
    'apps/api/src/moderation/commercial-ocr/commercial-ocr-detector-source.generated.ts',
    'infra/scripts/lib/change-impact-components.generated.sh',
    'apps/api/src/generated/prisma/client.ts',
  ]) {
    assert.equal((await getFileInfo(resolve(root, file), { ignorePath })).ignored, true, file);
  }
  assert.equal(
    (await getFileInfo(resolve(root, 'apps/miniapp/vite.config.ts'), { ignorePath })).ignored,
    false,
  );
});
