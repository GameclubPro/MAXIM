import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  assertManagedNetworkFoundationSource,
  MANAGED_NETWORK_FOUNDATION_MIGRATION,
  MANAGED_NETWORK_FOUNDATION_SOURCE_CHECKS,
} from './assert-managed-network-foundation-source.mjs';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const marker = 'maxim_topology_require_managed_network_foundation';

test('installed foundation retains the migration trigger, journal runner and atomic receipt/CAS writers', () => {
  assert.doesNotThrow(() => assertManagedNetworkFoundationSource('a'.repeat(40), read));
  for (const [path, fragments] of MANAGED_NETWORK_FOUNDATION_SOURCE_CHECKS) {
    const original = read(path).replace(/\s+/gu, '');
    for (const fragment of fragments) {
      const changed = original.replaceAll(fragment.replace(/\s+/gu, ''), 'removed_reader');
      assert.notEqual(changed, original, `Missing mutation: ${path} ${fragment}`);
      assert.throws(
        () =>
          assertManagedNetworkFoundationSource('a'.repeat(40), (candidate) =>
            candidate === path ? changed : read(candidate),
          ),
        /lacks managed network foundation readers\/writers/u,
        `${path}: ${fragment}`,
      );
    }
    assert.throws(
      () =>
        assertManagedNetworkFoundationSource('a'.repeat(40), (candidate) =>
          candidate === path ? `/* ${read(path)} */` : read(candidate),
        ),
      /lacks managed network foundation readers\/writers/u,
      `Comments cannot supply capability: ${path}`,
    );
  }
  assert.throws(() => assertManagedNetworkFoundationSource('main', read), /Exact source SHA/u);
});

test('both exact API source floors precede runtime, Git and build mutation', () => {
  for (const [path, sourceArg, transition] of [
    [
      'infra/scripts/vps-runtime-rollback.sh',
      'TARGET_FULL_SHA',
      'begin_runtime_rollback_transition',
    ],
    ['infra/scripts/vps-release-rollback.sh', 'API_SOURCE_SHA', 'begin_release_runtime_transition'],
  ]) {
    const source = read(path);
    const call = `${marker} "$${sourceArg}"`;
    const offset = source.indexOf(call);
    assert.ok(offset > 0, path);
    assert.equal(source.indexOf(call, offset + call.length), -1, path);
    assert.ok(source.lastIndexOf(`\n${transition}\n`) > offset, path);
    if (sourceArg === 'TARGET_FULL_SHA')
      assert.ok(source.indexOf('\ngit switch --detach "$TARGET_FULL_SHA"') > offset);
    else {
      const selection = source.lastIndexOf('if [[ "$SELECT_API" -eq 1 ]]; then', offset);
      assert.ok(selection >= 0);
      assert.ok(
        source.indexOf('API_SOURCE_SHA="${COMPONENT_SOURCE_SHA[api-shared]}"', selection) < offset,
      );
    }
    // FLAG: Existing applied-migration receipts keep this installation floor durable;
    // no feature flag, host marker deletion or count of pending rows relaxes it.
    assert.match(source, /_prisma_migrations WHERE finished_at IS NOT NULL/u);
  }
  assert.match(
    read('infra/scripts/lib/deploy-topology.sh'),
    /assert-managed-network-foundation-source\.mjs/u,
  );
  assert.ok(
    read(
      `apps/api/prisma/migrations/${MANAGED_NETWORK_FOUNDATION_MIGRATION}/migration.sql`,
    ).includes('channel_settings_revision_guard'),
  );
});

test('static-only immutable rollback skips the foundation source floor and remains offline', () => {
  const source = read('infra/scripts/vps-release-rollback.sh');
  const start = source.lastIndexOf(
    'if [[ "$SELECT_API" -eq 1 ]]; then',
    source.indexOf(`${marker} "$API_SOURCE_SHA"`),
  );
  const end = source.indexOf('\nfi\n', source.indexOf(`${marker} "$API_SOURCE_SHA"`)) + 4;
  const result = spawnSync(
    'bash',
    [
      '-c',
      `
    set -euo pipefail
    SELECT_API=0
    require_command() { echo forbidden-command >&2; return 1; }
    git() { echo forbidden-git >&2; return 1; }
    docker() { echo forbidden-docker >&2; return 1; }
    ${marker}() { echo forbidden-foundation-floor >&2; return 1; }
    ${source.slice(start, end)}
  `,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});
