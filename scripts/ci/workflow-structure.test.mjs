import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '../..');
const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');

function jobBody(id, nextId) {
  const start = workflow.indexOf(`  ${id}:\n`);
  const end = workflow.indexOf(`  ${nextId}:\n`, start + 1);
  assert.notEqual(start, -1, `Missing CI job ${id}`);
  assert.notEqual(end, -1, `Missing CI job following ${id}: ${nextId}`);
  return workflow.slice(start, end);
}

test('keeps the functional API lane separate from the median commercial benchmark', () => {
  const api = jobBody('api', 'postgres-races');
  const benchmark = jobBody('commercial-benchmark', 'miniapp');

  assert.match(api, /npm run check:ci --workspace @maxim\/api/u);
  assert.match(api, /NODE_OPTIONS:\s*--max-old-space-size=6144/u);
  assert.doesNotMatch(api, /check:api|commercial-benchmark/u);
  assert.match(benchmark, /COMMERCIAL_BENCHMARK_PROFILE: github-hosted/u);
  assert.match(benchmark, /npm run test:api:commercial-benchmark:ci/u);
});

test('requires duplicate, interval, Publisher, OCR and retention Redis flows in the blocking API lane', () => {
  const api = jobBody('api', 'postgres-races');
  assert.match(api, /redis:\s*image: redis:7-alpine/u);
  assert.match(api, /127\.0\.0\.1:6379:6379/u);
  assert.match(api, /--health-cmd "redis-cli ping"/u);
  assert.match(api, /MAXIM_TEST_REDIS_URL: redis:\/\/127\.0\.0\.1:6379/u);
  assert.match(
    api,
    /run: npm test --workspace @maxim\/api -- 'message-duplicate\|photo-duplicate-history\.redis\|rule-engine-media-cooldown\.redis\|traffic-protection\.redis\|publisher-dispatch-health\.redis\|chat-context-cache\.redis\|publisher-refresh-operation\.redis\|publisher-access-refresh\.redis\|commercial-ocr-admission\.redis\|marketplace-publisher-access\.redis\|retention-priority-admission\.redis-integration\|message-retention-admission\.redis-integration'/u,
  );
  assert.doesNotMatch(api, /continue-on-error|^ {6,}(?:- )?if:/mu);
  assert.equal(parse(workflow).jobs.api.if, "needs.impact.outputs.api == 'true'");
});

test('requires traffic revision and activation checks against local PostgreSQL', () => {
  const postgres = jobBody('postgres-races', 'commercial-benchmark');
  assert.match(postgres, /MAXIM_TEST_POSTGRES_URL: \$\{\{ env\.DATABASE_URL \}\}/u);
  assert.match(
    postgres,
    /npm test --workspace @maxim\/api -- traffic-protection\.migration-integration\.spec\.ts/u,
  );
  assert.doesNotMatch(postgres, /continue-on-error/u);
});

test('requires native quarantine isolation and delayed Redis reply coverage before release', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'apps/api/package.json'), 'utf8'));
  assert.match(
    pkg.scripts['test:postgres-races:unlocked'],
    /webhook-dependency-quarantine-postgres\.spec\.ts/u,
  );
  const postgres = jobBody('postgres-races', 'commercial-benchmark');
  assert.match(postgres, /npm run test:postgres-races --workspace @maxim\/api/u);
  assert.doesNotMatch(postgres, /continue-on-error/u);
  const required = workflow.slice(workflow.indexOf('  required:'));
  assert.match(required, /postgres-races/u);
  const api = jobBody('api', 'postgres-races');
  assert.match(api, /MAXIM_TEST_REDIS_URL:/u);
  assert.match(api, /npm test --workspace @maxim\/api -- 'message-duplicate\|/u);
});

test('native race coverage cannot silently skip its required stores or blocking lane', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'apps/api/package.json'), 'utf8'));
  assert.ok(
    pkg.scripts['test:postgres-races:unlocked'].startsWith(
      'node ../../scripts/require-postgres-race-env.mjs && ',
    ),
  );
  const postgres = jobBody('postgres-races', 'commercial-benchmark');
  assert.match(
    postgres,
    /CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL: postgresql:\/\/[^\s]+@127\.0\.0\.1:5432\//u,
  );
  assert.match(postgres, /MAXIM_TEST_REDIS_URL: redis:\/\/127\.0\.0\.1:6379/u);
  assert.match(postgres, /run: npm run test:postgres-races --workspace @maxim\/api/u);
  assert.doesNotMatch(postgres, /continue-on-error/u);
  const required = workflow.slice(workflow.indexOf('  required:'));
  assert.match(required, /postgres-races/u);
});

test('native race lane lists existing literal test paths without shell operators', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'apps/api/package.json'), 'utf8'));
  const command = pkg.scripts['test:postgres-races:unlocked'];
  const sections = command.split('--runTestsByPath ');
  assert.equal(sections.length, 2, 'Expected one explicit native test list');
  const paths = sections[1].trim().split(/\s+/u);
  assert.equal(new Set(paths).size, paths.length, 'Native test list contains duplicates');
  for (const path of paths) {
    assert.match(path, /^src\/[a-z0-9./-]+\.spec\.ts$/u, `Invalid native test path: ${path}`);
    assert.ok(statSync(resolve(root, 'apps/api', path)).isFile(), `Missing native test: ${path}`);
  }
  for (const path of [
    'src/max/max-fixed-moderator-assignment-postgres.spec.ts',
    'src/max/max-fixed-moderator-preservation-postgres.spec.ts',
    'src/webhook/webhook-multibot-fixed-fullpath.spec.ts',
    'src/scripts/cancel-webhook-backlog-v2-postgres.spec.ts',
    'src/scripts/cancel-webhook-backlog-v2-history-postgres.spec.ts',
    'src/scripts/cancel-webhook-backlog-v2-operation-plan-postgres.spec.ts',
    'src/admin/publication-admin-access-postgres.spec.ts',
  ]) {
    assert.ok(paths.includes(path), `Missing critical native regression: ${path}`);
  }
});

test('isolates every native shard and keeps all compatibility checks blocking', () => {
  const jobs = parse(workflow).jobs;
  const postgres = jobs['postgres-races'];
  const shards = Array.from({ length: 8 }, (_, index) => `${index + 1}/8`);
  assert.deepEqual(postgres.strategy.matrix.shard, [...shards, 'compatibility']);
  assert.equal(postgres.strategy['fail-fast'], false);
  assert.equal(postgres['timeout-minutes'], 10);
  assert.ok(postgres.services.postgres);
  assert.ok(postgres.services.redis);
  assert.equal(postgres.needs, 'impact', 'Shards only wait for the impact plan');
  assert.equal(postgres.if, "needs.impact.outputs.postgres_races == 'true'");
  const native = postgres.steps.find((step) => step.name === 'Native race shard');
  assert.equal(native.if, "matrix.shard != 'compatibility'");
  assert.equal(
    native.run,
    'npm run test:postgres-races --workspace @maxim/api -- -- --shard=${{ matrix.shard }} --json --outputFile=postgres-races.json',
  );
  const compatibility = postgres.steps.filter(
    (step) => step.if === "matrix.shard == 'compatibility'",
  );
  assert.deepEqual(
    compatibility.map((step) => step.name),
    [
      'Outcome cohort online migrations with native PostgreSQL',
      'Quarantine proof bounds with native PostgreSQL',
      'Check traffic policy revision and activation guards',
      'Participant report SQL, shared executor, journal and retention',
      'Retention admission and receipt recovery with PostgreSQL',
      'Conservative moderation rollup compatibility with PostgreSQL',
    ],
  );
  for (const step of postgres.steps) {
    assert.equal(step['continue-on-error'], undefined);
    if (step.if) {
      assert.ok(
        [
          "matrix.shard == 'compatibility'",
          "matrix.shard != 'compatibility'",
          "always() && matrix.shard != 'compatibility'",
        ].includes(step.if),
        `Unexpected native coverage condition: ${step.if}`,
      );
    }
  }
  assert.ok(jobs.required.needs.includes('postgres-races'));
  const gate = jobs.required.steps.find((step) => step.run === 'node scripts/ci/impact.mjs verify');
  assert.equal(gate.env.CI_NEEDS, '${{ toJSON(needs) }}');
  const report = postgres.steps.find((step) => step.name === 'Save native shard result');
  assert.equal(report.if, "always() && matrix.shard != 'compatibility'");
  assert.equal(report.with.path, 'apps/api/postgres-races.json');
});
