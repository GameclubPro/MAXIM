import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  OUTCOME_COHORT_HISTORICAL_COMPATIBILITY as rules,
  historicalCompatibilityCtes,
  historicalCompatibilityProjection,
  isCompatibleHistoricalReceipt,
} from '../../scripts/agent/outcome-cohort-historical-compatibility.mjs';
import {
  OUTCOME_COHORT_TARGETS,
  readOutcomeCohortSource,
} from '../../scripts/agent/outcome-cohort-online-targets.mjs';

const root = resolve(import.meta.dirname, '../..');
const source = readOutcomeCohortSource(root);
const receipt = ({ name, checksum }) => ({
  name,
  checksum,
  finished: true,
  rolled_back: false,
  steps: 1,
});
function fixture(rule = rules[0]) {
  const known = new Map(source.map(({ name, checksum }) => [name, checksum]));
  const active = new Map(source.map((entry) => [entry.name, receipt(entry)]));
  for (const historical of rules) active.set(historical.name, receipt(historical));
  return {
    known,
    active,
    proof: rules.map(({ name }) => ({ name, exact: true })),
    candidate: active.get(rule.name),
  };
}
const accepts = ({ candidate, known, active, proof }) =>
  isCompatibleHistoricalReceipt(candidate, known, active, proof);

test('the historical allowlist is exactly four immutable name/checksum pairs', () => {
  assert.deepEqual(
    rules.map(({ name, checksum }) => [name, checksum]),
    [
      [
        '20260301143000_add_commercial_scoring_settings',
        'bf0f08ea91e490406c5f04fe78895bdacd41eb2a475054b4b509390126068c99',
      ],
      [
        '20260301173000_add_delete_bots_messages_toggle',
        'e2be732e2c92320c22f82d89d827479532e256039ceb97e7316e200c983ee55e',
      ],
      [
        '20260311153000_add_night_mode_open_message_enabled',
        '6327681695854247dfe8d06a42f917ed6d2af9a61fce10cdff718446219c072b',
      ],
      [
        '20260311160000_add_night_mode_open_message_text',
        '65b381f01dcd3e2870c9290118941d8ee88f977c67232ba31332d730e9c9dc2b',
      ],
    ],
  );
  assert.ok(Object.isFrozen(rules));
  for (const rule of rules) {
    assert.ok(Object.isFrozen(rule));
    assert.ok(Object.isFrozen(rule.successors));
    assert.ok(rule.successors.every(Object.isFrozen));
    const f = fixture(rule);
    assert.equal(accepts(f), true, rule.name);
    assert.equal(f.known.get(rule.name) ?? null, rule.sourceChecksum);
    for (const successor of rule.successors)
      assert.equal(f.known.get(successor.name), successor.checksum);
  }
});

test('historical acceptance requires the exact retained successful attempt', () => {
  for (const rule of rules) {
    for (const change of [
      { name: `${rule.name}_foreign` },
      { checksum: 'f'.repeat(64) },
      { finished: false },
      { finished: 1 },
      { rolled_back: true },
      { rolled_back: null },
      { steps: -1 },
      { steps: 0 },
      { steps: 1.5 },
      { steps: '1' },
    ]) {
      const f = fixture(rule);
      Object.assign(f.candidate, change);
      assert.equal(accepts(f), false, `${rule.name}: ${JSON.stringify(change)}`);
    }
    const missing = fixture(rule);
    missing.active.delete(rule.name);
    assert.equal(accepts(missing), false);
    const conflicting = fixture(rule);
    conflicting.active.set(rule.name, { ...conflicting.candidate, checksum: 'f'.repeat(64) });
    assert.equal(accepts(conflicting), false);
    const foreign = fixture(rule);
    foreign.active.set(rule.name, { ...foreign.candidate, name: 'foreign' });
    assert.equal(accepts(foreign), false);
  }
  const f = fixture();
  assert.equal(isCompatibleHistoricalReceipt(null, f.known, f.active, f.proof), false);
  assert.equal(isCompatibleHistoricalReceipt(f.candidate, {}, f.active, f.proof), false);
  assert.equal(isCompatibleHistoricalReceipt(f.candidate, f.known, {}, f.proof), false);
});

test('exact current and successor source hashes cannot be substituted or removed', () => {
  for (const rule of rules) {
    const changed = fixture(rule);
    changed.known.set(rule.name, rule.checksum);
    assert.equal(accepts(changed), false, rule.name);
    if (rule.sourceChecksum !== null) {
      const missing = fixture(rule);
      missing.known.delete(rule.name);
      assert.equal(accepts(missing), false);
    }
    for (const successor of rule.successors) {
      const missing = fixture(rule);
      missing.known.delete(successor.name);
      assert.equal(accepts(missing), false, successor.name);
      const drifted = fixture(rule);
      drifted.known.set(successor.name, 'f'.repeat(64));
      drifted.active.get(successor.name).checksum = 'f'.repeat(64);
      assert.equal(accepts(drifted), false, successor.name);
    }
  }
});

test('replacement or successor presence alone never substitutes for its successful exact receipt', () => {
  for (const rule of rules) {
    for (const successor of rule.successors) {
      const absent = fixture(rule);
      absent.active.delete(successor.name);
      assert.equal(accepts(absent), false);
      for (const change of [
        { name: 'foreign' },
        { checksum: 'f'.repeat(64) },
        { finished: false },
        { rolled_back: true },
        { steps: -1 },
        { steps: 1.5 },
        { steps: '1' },
      ]) {
        const f = fixture(rule);
        Object.assign(f.active.get(successor.name), change);
        assert.equal(accepts(f), false, `${successor.name}: ${JSON.stringify(change)}`);
      }
      const settled = fixture(rule);
      settled.active.get(successor.name).steps = 0;
      assert.equal(accepts(settled), true, 'Retain the existing successful-receipt contract');
    }
  }
});

test('catalog proof is a complete fixed set of unique names and boolean exact results', () => {
  for (const rule of rules) {
    const f = fixture(rule);
    f.proof.find(({ name }) => name === rule.name).exact = false;
    assert.equal(accepts(f), false, rule.name);
  }
  for (const change of [
    (f) => (f.proof = null),
    (f) => (f.proof = {}),
    (f) => f.proof.pop(),
    (f) => f.proof.push(f.proof[0]),
    (f) => (f.proof[1] = f.proof[0]),
    (f) => (f.proof[1] = null),
    (f) => (f.proof[1] = []),
    (f) => (f.proof[1].name = 'foreign'),
    (f) => (f.proof[1].exact = 1),
    (f) => (f.proof[1].exact = 'true'),
    (f) => (f.proof[1].unexpected = true),
    (f) => delete f.proof[1].exact,
  ]) {
    const f = fixture();
    change(f);
    assert.equal(accepts(f), false);
  }
  const independent = fixture();
  independent.proof[1].exact = false;
  independent.proof.reverse();
  assert.equal(accepts(independent), true, 'Unrelated proof outcomes do not change this rule');
});

function fullSnapshot() {
  const f = fixture();
  return {
    receipts: [...f.active.values()].filter(
      ({ name }) => name < OUTCOME_COHORT_TARGETS[0].migration,
    ),
    indexes: OUTCOME_COHORT_TARGETS.map(({ selector }) => ({
      selector,
      present: false,
      exact: false,
    })),
    artifacts: [],
    builders: [],
    historicalCompatibility: f.proof,
  };
}

test('the full verifier accepts historical receipts independent of predecessor/replacement order', async () => {
  const { verifyOutcomeCohortPreparationState: verify } =
    await import('./outcome-cohort-online-state.mjs');
  for (const order of [
    (receipts) => receipts,
    (receipts) => receipts.reverse(),
    (receipts) => [...receipts.filter((_, n) => n % 2), ...receipts.filter((_, n) => n % 2 === 0)],
  ]) {
    const snapshot = fullSnapshot();
    snapshot.receipts = order(snapshot.receipts);
    assert.deepEqual(verify(snapshot, source), {
      state: 'prepare_delete',
      pending: ['delete', 'recipient'],
    });
  }
});

test('historical allowance never exposes an unrelated pending migration to Prisma', async () => {
  const { verifyOutcomeCohortPreparationState: verify } =
    await import('./outcome-cohort-online-state.mjs');
  for (const name of [
    '20261017005900_fixture_before_targets',
    '20261017010030_fixture_between_targets',
  ]) {
    const changed = [...source, { name, checksum: 'a'.repeat(64) }].sort((a, b) =>
      a.name.localeCompare(b.name, 'en'),
    );
    assert.throws(() => verify(fullSnapshot(), changed), /PREREQUISITE_MISSING/u, name);
  }
});

test('the full verifier refuses duplicate, absent, malformed and unfinished replacement evidence', async () => {
  const { verifyOutcomeCohortPreparationState: verify } =
    await import('./outcome-cohort-online-state.mjs');
  const replacement = rules[2].successors[0];
  for (const mutate of [
    (snapshot, applied) => snapshot.receipts.push({ ...applied }),
    (snapshot, applied) => {
      snapshot.receipts = snapshot.receipts.filter((entry) => entry !== applied);
    },
    (_snapshot, applied) => (applied.finished = false),
    (_snapshot, applied) => delete applied.finished,
    (_snapshot, applied) => (applied.rolled_back = true),
    (_snapshot, applied) => (applied.checksum = 'f'.repeat(64)),
    (_snapshot, applied) => (applied.steps = '1'),
    (snapshot) => delete snapshot.historicalCompatibility,
    (snapshot) => (snapshot.historicalCompatibility[2].exact = false),
    (snapshot) => snapshot.receipts.push(receipt({ name: 'foreign', checksum: 'f'.repeat(64) })),
  ]) {
    const snapshot = fullSnapshot();
    mutate(
      snapshot,
      snapshot.receipts.find(({ name }) => name === replacement.name),
    );
    assert.throws(() => verify(snapshot, source), /OUTCOME_COHORT_RECEIPT_BLOCKED/u);
  }
});

test('the full verifier cannot bypass historical source pins by restoring original SQL hashes', async () => {
  const { verifyOutcomeCohortPreparationState: verify } =
    await import('./outcome-cohort-online-state.mjs');
  for (const rule of rules) {
    const snapshot = fullSnapshot();
    const altered = source.filter(({ name }) => name !== rule.name);
    altered.push({ name: rule.name, checksum: rule.checksum });
    altered.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    assert.throws(() => verify(snapshot, altered), /OUTCOME_COHORT_RECEIPT_BLOCKED/u, rule.name);
  }
});

test('catalog SQL reads fixed current effects with bounded metadata and never evaluates defaults', () => {
  assert.match(historicalCompatibilityCtes, /^historical_relation AS MATERIALIZED/u);
  assert.equal(historicalCompatibilityCtes.includes(';'), false);
  for (const predicate of [
    "pg_catalog.to_regclass('public.chat_settings')",
    "relation.relkind = 'r'",
    "relation.relpersistence = 'p'",
    'relation.reltablespace = 0',
    'NOT relation.relhassubclass',
    'NOT relation.relispartition',
    'inheritance.inhrelid=relation.oid OR inheritance.inhparent=relation.oid',
    'attribute.atttypid=pg_catalog.to_regtype(expected.type_name)',
    'attribute.atttypmod = -1 AND attribute.attndims = 0',
    'attribute.attnotnull AND attribute.atthasdef',
    "attribute.attgenerated = '' AND attribute.attidentity = ''",
    'attribute.attislocal AND attribute.attinhcount = 0',
    'attribute.attcollation = definition.typcollation',
    'pg_catalog.pg_get_expr(defaults.adbin,defaults.adrelid,false)=expected.default_sql',
    'ORDER BY enumsortorder LIMIT 3',
    "ARRAY['BALANCED','STRICT']",
    "pg_catalog.to_regclass('public.chat_commercial_allowlist') IS NULL",
    "pg_catalog.to_regclass('public.chat_commercial_stoplist') IS NULL",
    "'commercial_ads_repeat_window_sec'",
    "'commercial_ads_low_confidence_log_enabled'",
    "'commercial_ads_warn_first_enabled'",
    "'remove_bots_from_group_enabled','pg_catalog.bool','false',false",
    "'night_mode_open_message_enabled','pg_catalog.bool','false',false",
    "'night_mode_open_message_text','pg_catalog.text'",
  ])
    assert.ok(historicalCompatibilityCtes.includes(predicate), predicate);
  assert.doesNotMatch(
    historicalCompatibilityCtes,
    /\b(?:UPDATE|INSERT|DELETE|EXECUTE|ALTER|DROP)\b/u,
  );
  assert.doesNotMatch(historicalCompatibilityCtes, /\bFROM\s+(?:public\.)?chat_settings\b/iu);
  assert.match(
    historicalCompatibilityProjection,
    /json_agg\(historical_compatibility ORDER BY name\)/u,
  );
  for (const rule of rules) assert.ok(historicalCompatibilityCtes.includes(rule.name));
});
