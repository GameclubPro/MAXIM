import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  assertManagedEntityActivationSource,
  MANAGED_ENTITY_ACTIVATION_SOURCE_CHECKS,
} from './assert-managed-entity-activation-source.mjs';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
test('rollback retains dormant observations and explicit per-bot activation', () => {
  assert.doesNotThrow(() => assertManagedEntityActivationSource('a'.repeat(40), read));
});
for (const [path, markers] of MANAGED_ENTITY_ACTIVATION_SOURCE_CHECKS) {
  for (const marker of markers)
    test(`activation rollback refuses missing reader ${path}: ${marker}`, () => {
      assert.throws(
        () =>
          assertManagedEntityActivationSource('a'.repeat(40), (sourcePath) =>
            sourcePath === path
              ? read(path).replaceAll(marker, 'removed_reader')
              : read(sourcePath),
          ),
        /lacks explicit bot activation readers/u,
      );
    });
}
test('rollback refuses a cache read ahead of the activation gate', () => {
  assert.throws(
    () =>
      assertManagedEntityActivationSource('a'.repeat(40), (path) =>
        path.endsWith('max-client.service.ts')
          ? read(path).replace(
              '    const activationState = this.maxBotLinkService?.assertChatBotAccessProbeAllowed',
              '    await this.readJsonCache();\n    const activationState = this.maxBotLinkService?.assertChatBotAccessProbeAllowed',
            )
          : read(path),
      ),
    /probes dormant bots/u,
  );
});
test('rollback refuses claim admission ahead of the durable dormant marker', () => {
  assert.throws(
    () =>
      assertManagedEntityActivationSource('a'.repeat(40), (path) =>
        path.endsWith('webhook.service.ts')
          ? read(path).replace(
              '    const executionAdmitted = await this.prisma.$transaction(async (tx) => {',
              '    await tx.webhookExecutionClaim.createMany({});\n    const executionAdmitted = await this.prisma.$transaction(async (tx) => {',
            )
          : read(path),
      ),
    /admits execution/u,
  );
});
test('both rollback entrypoints enforce activation readers before runtime mutation', () => {
  for (const path of [
    'infra/scripts/vps-runtime-rollback.sh',
    'infra/scripts/vps-release-rollback.sh',
  ]) {
    const source = read(path);
    const gate = source.indexOf('maxim_topology_require_managed_entity_activation');
    const transition = Math.max(
      source.lastIndexOf('\nbegin_release_runtime_transition\n'),
      source.lastIndexOf('\nbegin_runtime_rollback_transition\n'),
    );
    assert.ok(gate >= 0 && transition > gate, path);
  }
  assert.match(
    read('infra/scripts/lib/deploy-topology.sh'),
    /assert-managed-entity-activation-source\.mjs/u,
  );
});
