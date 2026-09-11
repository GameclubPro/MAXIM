import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('requires the message duplicate Redis flow in the blocking API lane', () => {
  const api = jobBody('api', 'postgres-races');
  assert.match(api, /redis:\s*image: redis:7-alpine/u);
  assert.match(api, /127\.0\.0\.1:6379:6379/u);
  assert.match(api, /--health-cmd "redis-cli ping"/u);
  assert.match(api, /MAXIM_TEST_REDIS_URL: redis:\/\/127\.0\.0\.1:6379/u);
  assert.match(api, /run: npm test --workspace @maxim\/api -- message-duplicate/u);
  assert.doesNotMatch(api, /continue-on-error|if:/u);
});
