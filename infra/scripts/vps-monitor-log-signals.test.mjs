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

function readRuntimePressureCommand() {
  const functionStart = monitor.indexOf('summarize_runtime_pressure() {');
  assert.notEqual(functionStart, -1, 'runtime pressure function is missing');
  const commandStartMarker = "remote_command=$(cat <<'REMOTE'\n";
  const commandStart = monitor.indexOf(commandStartMarker, functionStart);
  const commandEnd = monitor.indexOf('\nREMOTE\n', commandStart);
  assert.notEqual(commandStart, -1, 'runtime pressure command is missing');
  assert.notEqual(commandEnd, -1, 'runtime pressure command terminator is missing');
  return monitor.slice(commandStart + commandStartMarker.length, commandEnd);
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

test('reports the hard deploy free-space floor independently from percentage warnings', () => {
  const command = readRuntimePressureCommand();

  assert.match(command, /deploy_disk_hard_minimum_free_bytes="21474836480"/u);
  assert.match(command, /df -P -B1/u);
  assert.match(command, /DEPLOY_DISK_BLOCKED/u);
  assert.match(command, /disk_available_bytes < deploy_disk_hard_minimum_free_bytes/u);
  assert.doesNotMatch(command, /MAXIM_ALLOW_CRITICAL_DISK_DEPLOY/u);
});
