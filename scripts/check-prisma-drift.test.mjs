import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  checkPrismaDrift,
  comparePrismaDrift,
  digestPrismaDiff,
  formatClassificationCounts,
  formatPrismaDriftFailure,
  invokePinnedPrismaDiff,
  normalizePrismaDiff,
  splitPrismaDiffOperations,
  validatePrismaDriftBaseline,
} from './check-prisma-drift.mjs';

const root = resolve(import.meta.dirname, '..');

function createBaseline(operations) {
  return {
    format: 1,
    normalizedSha256: digestPrismaDiff(operations.join('\n\n')),
    classifications: {
      'prisma-unrepresentable': {
        description: 'Current Prisma schema syntax cannot represent this PostgreSQL DDL.',
        remediation: 'Keep the reviewed operation exact until Prisma can represent it.',
      },
    },
    operationGroups: [{ classification: 'prisma-unrepresentable', operations }],
  };
}

test('normalizes only line endings and terminal newlines', () => {
  assert.equal(
    normalizePrismaDiff('-- AlterTable  \r\nALTER  TABLE "chat";\t\r\n\r\n'),
    '-- AlterTable  \nALTER  TABLE "chat";\t',
  );
  assert.equal(normalizePrismaDiff('  SELECT  1;'), '  SELECT  1;');
  assert.equal(normalizePrismaDiff('\nSELECT 1;'), '\nSELECT 1;');
});

test('splits exact Prisma operation blocks without rewriting SQL', () => {
  assert.deepEqual(
    splitPrismaDiffOperations(
      '-- DropIndex\nDROP INDEX "one";\n\n-- AlterTable\nALTER TABLE "two";',
    ),
    ['-- DropIndex\nDROP INDEX "one";', '-- AlterTable\nALTER TABLE "two";'],
  );
});

test('accepts an exact known-drift baseline after nonsemantic output normalization', () => {
  const operations = [
    '-- DropIndex\nDROP INDEX "covering";',
    '-- AlterTable\nALTER TABLE "chat" ALTER COLUMN "updated_at" DROP DEFAULT;',
  ];
  const comparison = comparePrismaDrift(
    `${operations.join('\r\n\r\n')}\r\n`,
    createBaseline(operations),
  );

  assert.equal(comparison.matches, true);
  assert.deepEqual(comparison.added, []);
  assert.deepEqual(comparison.removed, []);
});

test('fails closed with added and removed operation details', () => {
  const expected = [
    '-- DropIndex\nDROP INDEX "known_covering";',
    '-- AlterTable\nALTER TABLE "chat" ALTER COLUMN "updated_at" DROP DEFAULT;',
  ];
  const unexpected =
    '-- AlterTable\nALTER TABLE "users" ADD COLUMN "schema_only_field" TEXT NOT NULL;';
  const comparison = comparePrismaDrift(
    [expected[0], unexpected].join('\n\n'),
    createBaseline(expected),
  );

  assert.equal(comparison.matches, false);
  assert.deepEqual(comparison.added, [unexpected]);
  assert.deepEqual(comparison.removed, [expected[1]]);
  const message = formatPrismaDriftFailure(comparison);
  assert.match(message, /schema change may be missing a migration/u);
  assert.match(message, /schema_only_field/u);
  assert.match(message, /updated_at/u);
});

test('fails exact comparison when only operation order changes', () => {
  const operations = ['-- One\nSELECT 1;', '-- Two\nSELECT 2;'];
  const comparison = comparePrismaDrift(
    [...operations].reverse().join('\n\n'),
    createBaseline(operations),
  );

  assert.equal(comparison.matches, false);
  assert.equal(comparison.orderOnlyDifference, true);
  assert.equal(comparison.firstDifferentOperation, 0);
  assert.deepEqual(comparison.added, []);
  assert.deepEqual(comparison.removed, []);
});

test('rejects a baseline whose operations and digest do not match', () => {
  const baseline = createBaseline(['-- One\nSELECT 1;']);
  baseline.operationGroups[0].operations[0] = '-- One\nSELECT 2;';

  assert.throws(() => validatePrismaDriftBaseline(baseline), /baseline digest is stale/u);
});

test('rejects undocumented and stale debt classifications', () => {
  const undocumented = createBaseline(['-- One\nSELECT 1;']);
  undocumented.operationGroups[0].classification = 'schema-alignment-debt';
  assert.throws(() => validatePrismaDriftBaseline(undocumented), /description and remediation/u);

  const stale = createBaseline(['-- One\nSELECT 1;']);
  stale.classifications['schema-alignment-debt'] = {
    description: 'Representable debt.',
    remediation: 'Align the schema.',
  };
  assert.throws(() => validatePrismaDriftBaseline(stale), /metadata is unused/u);
});

test('invokes the pinned repository Prisma diff against explicit DATABASE_URL', () => {
  const calls = [];
  const stdout = '-- AlterTable\nALTER TABLE "chat" ADD COLUMN "field" TEXT;\n';
  const output = invokePinnedPrismaDiff({
    root: '/repo',
    env: { DATABASE_URL: '  postgresql://ci/db  ', PATH: '/bin' },
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout, stderr: '' };
    },
  });

  assert.equal(output, stdout);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/repo/node_modules/.bin/prisma');
  assert.deepEqual(calls[0].args, [
    'migrate',
    'diff',
    '--from-config-datasource',
    '--to-schema',
    'prisma/schema.prisma',
    '--script',
    '--config',
    'prisma.config.ts',
  ]);
  assert.equal(calls[0].options.cwd, '/repo/apps/api');
  assert.equal(calls[0].options.env.DATABASE_URL, 'postgresql://ci/db');
});

test('refuses an implicit database and reports Prisma command failures', () => {
  assert.throws(
    () => invokePinnedPrismaDiff({ root: '/repo', env: {}, spawn: () => assert.fail() }),
    /DATABASE_URL is required/u,
  );
  assert.throws(
    () =>
      invokePinnedPrismaDiff({
        root: '/repo',
        env: { DATABASE_URL: 'postgresql://ci/db' },
        spawn: () => ({ status: 1, stdout: '', stderr: 'database unavailable' }),
      }),
    /database unavailable/u,
  );
});

test('supports injected command output and validates the committed baseline artifact', () => {
  const baseline = JSON.parse(
    readFileSync(resolve(root, 'config/prisma-drift-baseline.json'), 'utf8'),
  );
  const expected = validatePrismaDriftBaseline(baseline);
  const comparison = checkPrismaDrift({
    root,
    baseline,
    runDiff: () => expected.normalizedOutput,
  });

  assert.equal(comparison.matches, true);
  assert.deepEqual(comparison.classificationCounts, {
    'prisma-unrepresentable': 9,
    'schema-alignment-debt': 30,
    'missing-migration-debt': 1,
  });
  assert.equal(
    formatClassificationCounts(comparison.classificationCounts),
    'prisma-unrepresentable=9, schema-alignment-debt=30, missing-migration-debt=1',
  );
});
