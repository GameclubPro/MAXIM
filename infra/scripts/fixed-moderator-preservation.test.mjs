import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  assertPreservationFleet,
  assertPreservationReadiness,
  preservationDeadline,
} from './fixed-moderator-preservation-host.mjs';
import { readReviewedPreservationPlan } from './fixed-moderator-preservation-plan.mjs';

const sha = 'a'.repeat(40);
const manifest = {
  components: {
    'api-shared': {
      sourceSha: sha,
      imageRef: `maxim-api:${sha}`,
      imageId: `sha256:${'b'.repeat(64)}`,
    },
  },
};
const fleet = {
  available: true,
  expectedRoleCount: 14,
  observedRoleCount: 14,
  singletonRoleCount: 14,
  runningRoleCount: 14,
  identityRoleCount: 14,
  exactImageRoleCount: 14,
  duplicateContainerCount: 0,
  unexpectedApiContainerCount: 0,
  unexpectedMainContainerCount: 0,
  unexpectedScaleContainerCount: 0,
  unexpectedManualContainerCount: 0,
};
test('preservation refuses a partial, duplicate, mixed or unavailable API fleet', () => {
  assert.doesNotThrow(() => assertPreservationFleet(fleet, manifest, sha));
  for (const [key, value] of Object.entries(fleet)) {
    assert.throws(() =>
      assertPreservationFleet(
        { ...fleet, [key]: typeof value === 'boolean' ? false : value + 1 },
        manifest,
        sha,
      ),
    );
  }
  assert.throws(() => assertPreservationFleet(fleet, manifest, 'c'.repeat(40)));
  assert.throws(() => assertPreservationFleet(fleet, {}, sha));
});
test('preservation requires positive dependency proof and bounded current lag', () => {
  const ready = {
    ok: true,
    checks: { database: true, redis: true, queueLag: { ok: true, operationalLagSec: 0 } },
  };
  assert.doesNotThrow(() => assertPreservationReadiness(ready));
  for (const value of [
    null,
    {},
    { ...ready, ok: false },
    { ...ready, checks: { ...ready.checks, database: false } },
    ...[NaN, Infinity, 11, undefined].map((lag) => ({
      ...ready,
      checks: { ...ready.checks, queueLag: { ok: true, operationalLagSec: lag } },
    })),
  ])
    assert.throws(() => assertPreservationReadiness(value));
});
test('preflight consumes the same absolute deadline and cannot renew it before launch', () => {
  const now = 1_000_000;
  const deadline = preservationDeadline(String(now + 75000), now);
  assert.equal(preservationDeadline(deadline, now + 65000, 10000), deadline);
  assert.throws(() => preservationDeadline(deadline, now + 65001, 10000));
  for (const invalid of ['', undefined, 'Infinity', now - 1, now + 80001, now + 0.5])
    assert.throws(() => preservationDeadline(invalid, now));
});
test('reviewed plans require private regular files, the exact release and unchanged content', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-preservation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'plan.json');
  const plan = { protocol: 'PRESERVE_EXISTING_MODERATOR_V1', sourceSha: sha, entries: [] };
  const raw = JSON.stringify(plan);
  const digest = createHash('sha256').update(raw).digest('hex');
  writeFileSync(file, raw, { mode: 0o600 });
  assert.equal(readReviewedPreservationPlan(file, sha, digest), raw);
  assert.throws(() => readReviewedPreservationPlan(file, 'c'.repeat(40), digest));
  assert.throws(() => readReviewedPreservationPlan(file, sha, '0'.repeat(64)));
  chmodSync(file, 0o644);
  assert.throws(() => readReviewedPreservationPlan(file, sha, digest));
  chmodSync(file, 0o600);
  const link = join(directory, 'link.json');
  symlinkSync(file, link);
  assert.throws(() => readReviewedPreservationPlan(link, sha, digest));
  writeFileSync(file, ' '.repeat(256 * 1024 + 1));
  assert.throws(() => readReviewedPreservationPlan(file, sha, digest));
});
