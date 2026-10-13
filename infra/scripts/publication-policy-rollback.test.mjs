import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  assertPublicationPolicySource,
  PUBLICATION_POLICY_SOURCE_CHECKS,
} from './assert-publication-policy-source.mjs';

test('rollback requires the deadline reader, every execution boundary and the untouched-target CAS', () => {
  const sources = new Map(
    PUBLICATION_POLICY_SOURCE_CHECKS.map(([path]) => [
      path,
      readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'),
    ]),
  );
  assert.doesNotThrow(() => assertPublicationPolicySource((path) => sources.get(path)));
  for (const [path, fragments] of PUBLICATION_POLICY_SOURCE_CHECKS) {
    for (const fragment of fragments) {
      const before = sources.get(path).replace(/\s+/gu, '');
      const after = before.replaceAll(fragment.replace(/\s+/gu, ''), 'unsafe_reader');
      assert.notEqual(after, before, `Missing mutation: ${fragment}`);
      assert.throws(
        () =>
          assertPublicationPolicySource((candidate) =>
            candidate === path ? after : sources.get(candidate),
          ),
        /Rollback target lacks/u,
      );
    }
  }
  for (const path of ['vps-runtime-rollback.sh', 'vps-release-rollback.sh'])
    assert.match(
      readFileSync(new URL(path, import.meta.url), 'utf8'),
      /maxim_topology_require_publication_policy/u,
    );
});
