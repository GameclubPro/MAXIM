import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { globToBashEre, renderDeployImpactBash } from '../generate-deploy-impact-bash.mjs';

const root = resolve(import.meta.dirname, '../../..');
const configPath = resolve(root, 'config/change-impact.json');
const generatedPath = resolve(root, 'infra/scripts/lib/change-impact-components.generated.sh');

test('translates impact globs to slash-aware Bash regular expressions', () => {
  assert.match('apps/api/src/main.ts', new RegExp(globToBashEre('apps/api/**'), 'u'));
  assert.doesNotMatch('apps/api/deep/main.ts', new RegExp(globToBashEre('apps/api/*.ts'), 'u'));
  assert.match('AGENTS.md', new RegExp(globToBashEre('**/AGENTS.md'), 'u'));
});

test('keeps the checked-in Bash mapping synchronized with the impact config', () => {
  const rawConfig = readFileSync(configPath, 'utf8');
  assert.equal(readFileSync(generatedPath, 'utf8'), renderDeployImpactBash(rawConfig));
});

test('classifies deploy components in Bash and fails closed for unknown paths', () => {
  assert.deepEqual(classify('apps/api/src/main.ts'), [1, 0, 0, 0]);
  assert.deepEqual(classify('apps/api/src/main.spec.ts'), [0, 0, 0, 0]);
  assert.deepEqual(classify('apps/miniapp/src/main.tsx'), [0, 1, 0, 0]);
  assert.deepEqual(classify('apps/admin/src/main.tsx'), [0, 0, 1, 0]);
  assert.deepEqual(classify('packages/contracts/src/core.ts'), [1, 1, 1, 0]);
  assert.deepEqual(classify('config/prisma-migration-policy.json'), [0, 0, 0, 0]);
  assert.deepEqual(classify('future/unclassified.file'), [1, 1, 1, 1]);
});

function classify(path) {
  const output = execFileSync(
    'bash',
    [
      '-c',
      'source "$1"; maxim_impact_classify_path "$2"; printf "%s %s %s %s\\n" "$MAXIM_IMPACT_PATH_API_SHARED" "$MAXIM_IMPACT_PATH_MINIAPP_MAJOR_STATIC" "$MAXIM_IMPACT_PATH_ADMIN_STATIC" "$MAXIM_IMPACT_PATH_UNKNOWN"',
      'maxim-impact-test',
      generatedPath,
      path,
    ],
    { encoding: 'utf8' },
  );
  return output
    .trim()
    .split(' ')
    .map((value) => Number(value));
}
