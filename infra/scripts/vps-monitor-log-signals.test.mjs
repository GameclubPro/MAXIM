import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const monitor = readFileSync(resolve(root, 'infra/scripts/vps-monitor-readonly.sh'), 'utf8');

function readRateLimitPattern() {
  const match = /count '([^']*rate\[[^']+)'/u.exec(monitor);
  assert.ok(match?.[1], 'monitor rate-limit signal pattern is missing');
  return match[1];
}

function readSuccessfulAccessLogPattern() {
  const match = /^SUCCESSFUL_ACCESS_LOG_PATTERN='([^']+)'$/mu.exec(monitor);
  assert.ok(match?.[1], 'monitor successful access-log pattern is missing');
  return match[1];
}

function countSignals(lines) {
  const result = spawnSync('grep', ['-Eci', readRateLimitPattern()], {
    input: `${lines.join('\n')}\n`,
    encoding: 'utf8',
  });
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  return Number.parseInt(result.stdout.trim() || '0', 10);
}

function filterSuccessfulAccessLogs(lines) {
  const result = spawnSync('grep', ['-Eav', readSuccessfulAccessLogPattern()], {
    input: `${lines.join('\n')}\n`,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n');
}

test('does not count epoch timestamps containing 429 as rate-limit signals', () => {
  assert.equal(
    countSignals([
      '{"level":30,"time":1784429457196,"statusCode":200,"msg":"request completed"}',
      '{"level":30,"time":1784429429000,"statusCode":204,"msg":"request completed"}',
    ]),
    0,
  );
});

test('counts explicit internal, structured, and HTTP 429 rate-limit signals', () => {
  assert.equal(
    countSignals([
      'MAX API internal limiter rejected request before dispatch',
      '{"statusCode":429,"msg":"request completed"}',
      'upstream returned HTTP status 429',
    ]),
    3,
  );
});

test('filters successful static access logs before scanning error-like asset names', () => {
  assert.equal(
    [...monitor.matchAll(/grep -Eav '\$\{SUCCESSFUL_ACCESS_LOG_PATTERN\}'/gu)].length,
    2,
  );
  assert.deepEqual(
    filterSuccessfulAccessLogs([
      'GET /app/assets/api-request-error-hash.js HTTP/1.1" 200 723',
      'GET /app/assets/warn-icon.svg HTTP/1.1" 304 0',
      'GET /app/assets/api-request-error-hash.js HTTP/1.1" 502 157',
      'nginx: [error] upstream prematurely closed connection',
    ]),
    [
      'GET /app/assets/api-request-error-hash.js HTTP/1.1" 502 157',
      'nginx: [error] upstream prematurely closed connection',
    ],
  );
});
