import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

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

test('requires duplicate, interval, Publisher pause and OCR admission Redis flows in the blocking API lane', () => {
  const api = jobBody('api', 'postgres-races');
  assert.match(api, /redis:\s*image: redis:7-alpine/u);
  assert.match(api, /127\.0\.0\.1:6379:6379/u);
  assert.match(api, /--health-cmd "redis-cli ping"/u);
  assert.match(api, /MAXIM_TEST_REDIS_URL: redis:\/\/127\.0\.0\.1:6379/u);
  assert.match(
    api,
    /run: npm test --workspace @maxim\/api -- 'message-duplicate\|photo-duplicate-history\.redis\|rule-engine-media-cooldown\.redis\|traffic-protection\.redis\|publisher-dispatch-health\.redis\|chat-context-cache\.redis\|publisher-refresh-operation\.redis\|publisher-access-refresh\.redis\|commercial-ocr-admission\.redis\|marketplace-publisher-access\.redis'/u,
  );
  assert.doesNotMatch(api, /continue-on-error|if:/u);
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
  ]) {
    assert.ok(paths.includes(path), `Missing fixed moderator regression: ${path}`);
  }
});
