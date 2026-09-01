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

function readFunction(name) {
  const match = new RegExp(`^${name}\\(\\) \\{\\n([\\s\\S]*?)^\\}`, 'mu').exec(monitor);
  assert.ok(match?.[1], `${name} function is missing`);
  return `${name}() {\n${match[1]}}\n`;
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

test('serializes full-fleet readonly monitors before production sampling', () => {
  const lockIndex = monitor.indexOf('flock -n "$MONITOR_LOCK_FD"');
  const sampleIndex = monitor.indexOf('run_monitor\n');

  assert.notEqual(lockIndex, -1, 'monitor process lock is missing');
  assert.notEqual(sampleIndex, -1, 'monitor entrypoint is missing');
  assert.ok(lockIndex < sampleIndex, 'monitor lock must be acquired before the first sample');
  assert.match(monitor, /MAXIM_MONITOR_LOCK_FILE/u);
  assert.match(monitor, /exec \{MONITOR_LOCK_FD\}>>"\$MONITOR_LOCK_FILE"/u);
  assert.doesNotMatch(monitor, /exec \{MONITOR_LOCK_FD\}>"\$MONITOR_LOCK_FILE"/u);
  assert.match(monitor, /Another readonly VPS monitor already holds/u);
});

test('uses successful remote cursors and reports bounded log saturation', () => {
  assert.match(monitor, /monitor_service_log_cursor_sec=\\\$scan_cursor_sec/u);
  assert.match(monitor, /monitor_static_log_cursor_sec=\\\$scan_cursor_sec/u);
  assert.match(monitor, /LAST_SERVICE_LOG_SCAN_AT_SEC="\$cursor_sec"/u);
  assert.match(monitor, /LAST_STATIC_LOG_SCAN_AT_SEC="\$cursor_sec"/u);
  assert.match(monitor, /logs --since "\$since_at"/u);
  assert.match(monitor, /WARN: could not read logs for \\\$service/u);
  assert.match(monitor, /exit "\\\$failed"/u);
  assert.doesNotMatch(monitor, /logs --since "\$\{INTERVAL_SEC\}s"/u);
  assert.match(monitor, /LOG_REQUEST_LINES=\$\(\(TAIL_LINES \+ 1\)\)/u);
  assert.equal(
    [...monitor.matchAll(/log scan saturated=true service=\\\$service/gu)].length,
    2,
  );
  for (const [functionName, cursor] of [
    ['scan_service_logs', 'LAST_SERVICE_LOG_SCAN_AT_SEC'],
    ['summarize_static_services', 'LAST_STATIC_LOG_SCAN_AT_SEC'],
  ]) {
    const source = readFunction(functionName);
    assert.ok(source.indexOf('if ((status != 0))') < source.indexOf(`${cursor}="$cursor_sec"`));
  }
  const bullMqStart = monitor.indexOf('summarize_bullmq_state() {');
  const bullMqEnd = monitor.indexOf('\nsummarize_redis_runtime() {', bullMqStart);
  assert.notEqual(bullMqStart, -1, 'BullMQ monitor function is missing');
  assert.notEqual(bullMqEnd, -1, 'BullMQ monitor function terminator is missing');
  const bullMqSource = monitor.slice(bullMqStart, bullMqEnd);
  assert.match(bullMqSource, /previous_probe_at_ms/u);
  assert.match(bullMqSource, /monitor_bullmq_cursor_ms/u);
  assert.match(bullMqSource, /if ! counts="\$\(redis-cli/u);
  assert.doesNotMatch(bullMqSource, /redis-cli[^\n]+\|\| true/u);
  assert.ok(
    bullMqSource.indexOf('if ((status != 0))') <
      bullMqSource.indexOf('LAST_BULLMQ_PROBE_AT_MS="$cursor_ms"'),
  );
});

test('adds privacy-safe semantic, Publisher, and media-analysis readiness to every sample', () => {
  assert.match(monitor, /run_step semantic-health summarize_local_ready_health/u);
  const semanticHealth = readFunction('summarize_local_ready_health');
  assert.match(semanticHealth, /vps-connect\.sh exec 'node -'/u);
  assert.match(semanticHealth, /< "\$ROOT_DIR\/infra\/scripts\/monitor-ready-status\.cjs"/u);
  assert.doesNotMatch(semanticHealth, /node infra\/scripts\/monitor-ready-status\.cjs/u);
  assert.doesNotMatch(semanticHealth, /curl -f/u);
  assert.match(monitor, /run_step publisher-runtime summarize_publisher_runtime/u);
  assert.match(monitor, /monitor-publisher-status\.cjs/u);
  assert.match(monitor, /read_expected api-admin/u);
  assert.match(monitor, /read_expected api-publisher/u);
  assert.match(monitor, /read_bot_id api-admin/u);
  assert.match(monitor, /read_bot_id api-publisher/u);
  assert.match(monitor, /bot_id_parity/u);
  assert.match(monitor, /admin_bot_id="\$\(read_bot_id api-admin\)" \|\| exit 1/u);
  assert.match(monitor, /publisher_bot_id="\$\(read_bot_id api-publisher\)" \|\| exit 1/u);
  assert.match(monitor, /\[\[ -n "\$admin_bot_id" && "\$admin_bot_id" == "\$publisher_bot_id" \]\]/u);
  assert.doesNotMatch(monitor, /exec -T -e MAX_PUBLISHER_BOT_ID=/u);
  assert.match(monitor, /run_step media-analysis-ready summarize_media_analysis_ready/u);
  assert.match(monitor, /monitor-media-ready\.cjs/u);
  assert.doesNotMatch(monitor, /fingerprintSha256=/u);
});

test('reports only allowlisted Redis pressure and persistence fields', () => {
  assert.match(monitor, /run_step redis-runtime summarize_redis_runtime/u);
  assert.match(monitor, /redis-cli --raw INFO all/u);
  assert.match(monitor, /set -o pipefail/u);
  assert.match(monitor, /monitor-redis-info\.cjs/u);
  assert.doesNotMatch(monitor, /redis-cli --raw (KEYS|SCAN|HGETALL)/u);
});

test('reports the hard deploy free-space floor independently from percentage warnings', () => {
  const command = readRuntimePressureCommand();

  assert.match(monitor, /source "\$ROOT_DIR\/infra\/scripts\/lib\/deploy-disk-capacity\.sh"/u);
  assert.match(monitor, /printf -v disk_capacity_env 'MAXIM_API_BUILD_HARD_MIN_FREE_BYTES=%q\\n'/u);
  assert.match(monitor, /remote_command="\$disk_capacity_env\$remote_command"/u);
  assert.doesNotMatch(command, /source infra\/scripts\/lib\/deploy-disk-capacity\.sh/u);
  assert.match(
    command,
    /deploy_disk_hard_minimum_free_bytes="\$MAXIM_API_BUILD_HARD_MIN_FREE_BYTES"/u,
  );
  assert.match(command, /df -P -B1/u);
  assert.match(command, /API_BUILD_DISK_BLOCKED/u);
  assert.match(command, /disk_available_bytes < deploy_disk_hard_minimum_free_bytes/u);
  assert.doesNotMatch(command, /MAXIM_ALLOW_CRITICAL_DISK_DEPLOY/u);
});
