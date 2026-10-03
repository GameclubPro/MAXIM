import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import {
  assertRuntimeContextBoundaries,
  compareRuntimeContextBaseline,
  findRuntimeContextFindings,
} from './check-runtime-contexts.mjs';

const filename = 'apps/api/src/admin/example-runtime-context.ts';
const scan = (source) => findRuntimeContextFindings(source, filename);

test('context factories reject broad inputs and assertions, including nested and arrow adapters', () => {
  for (const source of [
    'export function createExampleRuntimeContext(target: object) { return target as Context; }',
    'export function createExampleRuntimeContext(target: any) { return target; }',
    'export function createExampleRuntimeContext(target: unknown) { return target; }',
    'export function createExampleRuntimeContext(target) { return target; }',
    'export const createExampleRuntimeContext = (target: object) => target as Context;',
    'export function createExampleRuntimeContext(target: Context) { return { get client() { return <Client>target.client; } }; }',
  ])
    assert.equal(scan(source).length, 1, source);
  assert.deepEqual(
    scan(
      'export function createExampleRuntimeContext(deps: Context) { return { get cache() { return deps.cache; }, check() { return deps.check(); } }; }',
    ),
    [],
  );
  assert.deepEqual(
    scan(
      'export function createExampleRuntimeContext(deps: Context) { return { state: "ready" as const, client: deps.client }; }',
    ),
    [],
  );
});

test('compatibility ports cannot derive capabilities from a legacy class through an import alias', () => {
  assert.equal(
    findRuntimeContextFindings(
      "import type { AdminService as Legacy } from './admin.service'; export type Port = Pick<Legacy, 'run'>;",
      'apps/api/src/admin/example-legacy.port.ts',
    ).length,
    1,
  );
  assert.deepEqual(
    findRuntimeContextFindings(
      'export interface Port { run(id: string): Promise<void>; }',
      'apps/api/src/admin/example-legacy.port.ts',
    ),
    [],
  );
});

test('legacy exceptions pin unchanged adapters, reject new or modified bridges, and shrink after extraction', () => {
  const source =
    'export function createExampleRuntimeContext(target: object) { return target as Context; }';
  const original = scan(source);
  const baseline = { version: 1, exceptions: original };
  assert.deepEqual(compareRuntimeContextBaseline(original, baseline), []);
  assert.deepEqual(
    compareRuntimeContextBaseline(scan('// harmless comment\n' + source), baseline),
    [],
  );
  assert.equal(
    compareRuntimeContextBaseline(
      scan(source.replace('target as Context', '{ ...target } as Context')),
      baseline,
    ).length,
    1,
  );
  assert.equal(
    compareRuntimeContextBaseline(scan(source.replaceAll('Example', 'Another')), baseline).length,
    2,
  );
  assert.match(compareRuntimeContextBaseline([], baseline)[0], /obsolete/u);
  assert.throws(
    () =>
      compareRuntimeContextBaseline(original, {
        version: 1,
        exceptions: [...original, ...original],
      }),
    /Duplicate/u,
  );
  assert.throws(
    () => compareRuntimeContextBaseline(original, { version: 2, exceptions: [] }),
    /Invalid/u,
  );
});

test('repository context adapters do not expand the reviewed legacy baseline', () => {
  assertRuntimeContextBoundaries(resolve(import.meta.dirname, '..'));
});
