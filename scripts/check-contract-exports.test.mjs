import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { findContractsArchitectureViolations } from './check-contract-exports.mjs';

function write(root, path, contents) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'maxim-contract-guard-'));
  write(root, 'packages/contracts/src/index.ts', 'export const value = 1;\n');
  write(
    root,
    'packages/contracts/package.json',
    JSON.stringify({
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    }),
  );
  write(
    root,
    'tsconfig.base.json',
    JSON.stringify({
      compilerOptions: { paths: { '@maxim/contracts': ['packages/contracts/src/index.ts'] } },
    }),
  );
  write(
    root,
    'apps/api/jest.config.cjs',
    "module.exports = { moduleNameMapper: { '^@maxim/contracts$': '<rootDir>/../../packages/contracts/src/index.ts' } };\n",
  );
  return root;
}

test('accepts exact package, TypeScript, and Jest mappings', () => {
  assert.deepEqual(findContractsArchitectureViolations(createFixture()), []);
});

test('rejects a correct key with an incorrect target', () => {
  const root = createFixture();
  write(
    root,
    'tsconfig.base.json',
    JSON.stringify({ compilerOptions: { paths: { '@maxim/contracts': ['wrong.ts'] } } }),
  );

  assert.match(
    findContractsArchitectureViolations(root)
      .map(({ message }) => message)
      .join('\n'),
    /must map @maxim\/contracts exactly/u,
  );
});

test('rejects missing sources and wildcard escape hatches', () => {
  const root = createFixture();
  write(
    root,
    'packages/contracts/package.json',
    JSON.stringify({
      exports: {
        '.': { types: './dist/index.d.ts', default: './dist/index.js' },
        './missing': { types: './dist/missing.d.ts', default: './dist/missing.js' },
      },
    }),
  );
  write(
    root,
    'tsconfig.base.json',
    JSON.stringify({
      compilerOptions: {
        paths: {
          '@maxim/contracts': ['packages/contracts/src/index.ts'],
          '@maxim/contracts/*': ['packages/contracts/src/*'],
        },
      },
    }),
  );

  const messages = findContractsArchitectureViolations(root)
    .map(({ message }) => message)
    .join('\n');
  assert.match(messages, /has no source file/u);
  assert.match(messages, /maps @maxim\/contracts\/\*/u);
});

test('rejects focused contract entries that import the root core module', () => {
  const root = createFixture();
  write(root, 'packages/contracts/src/focused.ts', "export { value } from './core.js';\n");
  write(root, 'packages/contracts/src/core.ts', 'export const value = 1;\n');
  write(
    root,
    'packages/contracts/package.json',
    JSON.stringify({
      exports: {
        '.': { types: './dist/index.d.ts', default: './dist/index.js' },
        './focused': { types: './dist/focused.d.ts', default: './dist/focused.js' },
      },
    }),
  );
  write(
    root,
    'tsconfig.base.json',
    JSON.stringify({
      compilerOptions: {
        paths: {
          '@maxim/contracts': ['packages/contracts/src/index.ts'],
          '@maxim/contracts/focused': ['packages/contracts/src/focused.ts'],
        },
      },
    }),
  );
  write(
    root,
    'apps/api/jest.config.cjs',
    "module.exports = { moduleNameMapper: { '^@maxim/contracts$': '<rootDir>/../../packages/contracts/src/index.ts', '^@maxim/contracts/focused$': '<rootDir>/../../packages/contracts/src/focused.ts' } };\n",
  );

  assert.match(
    findContractsArchitectureViolations(root)
      .map(({ message }) => message)
      .join('\n'),
    /focused contract entry and must not import the root core module/u,
  );
});
