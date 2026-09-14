import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import archive from './monitor-capacity-archive.cjs';
import reportModule from './monitor-capacity-report.cjs';

const report = {
  ...reportModule,
  buildReport: (options) => reportModule.buildReport(options, Date.parse('2026-09-15T00:00:00Z')),
};

const from = '2026-09-14T10:59:00Z';
const to = '2026-09-14T11:04:00Z';
const cli = new URL('./monitor-capacity-report.cjs', import.meta.url).pathname;

function sample(observedAt, lag = 0.5) {
  return {
    schemaVersion: 1,
    observedAt,
    host: { cpuCount: 8, load1: 4, cpuIowaitPct: 2 },
    readiness: {
      available: true,
      httpStatus: 200,
      ok: true,
      database: true,
      redis: true,
      rawOk: true,
      queueOk: true,
      softWarning: false,
      softWarningCode: 'none',
      queueLagSec: lag,
      mode: 'normal',
      condition: 'healthy',
      burstActive: false,
    },
    adminReadiness: { available: true, httpStatus: 200, ok: true, database: true, redis: true },
    queueFence: {
      available: true,
      queueCount: 24,
      pausedCount: 0,
      activeCount: 0,
      ownerPresent: false,
    },
    apiFleet: {
      available: true,
      expectedRoleCount: 13,
      observedRoleCount: 13,
      singletonRoleCount: 13,
      runningRoleCount: 13,
      identityRoleCount: 13,
      exactImageRoleCount: 13,
      duplicateContainerCount: 0,
      unexpectedApiContainerCount: 0,
      unexpectedMainContainerCount: 0,
      unexpectedScaleContainerCount: 0,
      unexpectedManualContainerCount: 0,
      totalRestartCount: 0,
    },
    token: 'private-token-sentinel',
    chatId: 'private-chat-sentinel',
    payload: 'private-payload-sentinel',
  };
}

function series(start = from, lag = 0.5) {
  return Array.from({ length: 20 }, (_, index) =>
    sample(new Date(Date.parse(start) + index * 15_000).toISOString(), lag),
  );
}

function fixture(t, samples = series()) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-capacity-report-'));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const groups = new Map();
  for (const entry of samples) {
    const filename = archive.archiveFilename(entry.observedAt);
    const rows = groups.get(filename) ?? [];
    rows.push(JSON.stringify({ schemaVersion: 1, sample: entry, rawLog: 'private-log-sentinel' }));
    groups.set(filename, rows);
  }
  const files = [...groups].map(([filename, rows]) => {
    const path = join(directory, filename);
    writeFileSync(path, `${rows.join('\n')}\n`, { mode: 0o600 });
    return path;
  });
  return { directory, files };
}

test('reports a continuous cross-hour window without changing files or exposing raw metadata', (t) => {
  const { directory, files } = fixture(t);
  const before = files.map((path) => [readFileSync(path, 'utf8'), statSync(path).mtimeMs]);
  const result = report.buildReport({ directory, from, to });
  assert.equal(result.basis, 'sampled_oldest_queue_lag');
  assert.equal(result.current.status, 'healthy');
  assert.equal(result.current.coverage.status, 'complete');
  assert.equal(result.current.sampleCount, 20);
  assert.deepEqual(result.current.lagSec, {
    samples: 20,
    min: 0.5,
    p50: 0.5,
    p95: 0.5,
    p99: 0.5,
    max: 0.5,
  });
  assert.doesNotMatch(JSON.stringify(result), /private-|chatId|payload|rawLog/u);
  assert.deepEqual(
    files.map((path) => [readFileSync(path, 'utf8'), statSync(path).mtimeMs]),
    before,
  );
});

test('reports exact nearest-rank percentiles and does not count unknown lag as zero', () => {
  assert.deepEqual(
    report.percentiles([null, ...Array.from({ length: 100 }, (_, index) => index + 1)]),
    { samples: 100, min: 1, p50: 50, p95: 95, p99: 99, max: 100 },
  );
  assert.equal(report.percentiles([null]).p95, null);
});

test('distinguishes missing archive coverage from healthy runtime', (t) => {
  const { directory } = fixture(t, []);
  const result = report.buildReport({ directory, from, to });
  assert.equal(result.current.status, 'unknown');
  assert.equal(result.current.coverage.status, 'insufficient');
  assert.equal(result.current.lagSec.samples, 0);
  assert.equal(result.current.last, null);
});

test('rejects sparse gaps even when enough samples exist', (t) => {
  const rows = series().filter((_row, index) => index < 5 || index > 13);
  const { directory } = fixture(t, rows);
  const result = report.buildReport({ directory, from, to });
  assert.equal(result.current.status, 'unknown');
  assert.equal(result.current.coverage.status, 'insufficient');
  assert.equal(result.current.coverage.maxGapSec, 150);
});

test('keeps readiness, stale data, queue fences, and fleet failures visible', (t) => {
  const rows = series();
  rows[0].adminReadiness.ok = false;
  rows[1].queueFence.ownerPresent = true;
  rows[2].apiFleet.exactImageRoleCount = 12;
  rows[3].readiness.softWarning = true;
  rows[3].readiness.softWarningCode = 'stale-ready-fallback';
  rows[4].readiness.queueLagSec = 40;
  const { directory } = fixture(t, rows);
  const result = report.buildReport({ directory, from, to });
  assert.equal(result.current.status, 'degraded');
  for (const key of [
    'readiness',
    'queue_fence',
    'api_fleet_topology',
    'queue_metrics',
    'queue_lag_critical',
  ]) {
    assert.equal(result.current.checks[key].failing, 1);
  }
});

test('compares equal earlier windows while retaining known failures in the baseline', (t) => {
  const compareFrom = '2026-09-14T10:54:00Z';
  const compareTo = from;
  const { directory } = fixture(t, [...series(compareFrom, 20), ...series()]);
  const result = report.buildReport({ directory, from, to, compareFrom, compareTo });
  assert.equal(result.baseline.status, 'degraded');
  assert.deepEqual(result.comparison, {
    comparable: true,
    p95LagChangeSec: -19.5,
    maxLagChangeSec: -19.5,
  });
});

test('does not compare incomplete or partly unknown baselines', (t) => {
  const compareFrom = '2026-09-14T10:54:00Z';
  const rows = series(compareFrom, 20);
  rows[0].apiFleet.available = null;
  const { directory } = fixture(t, [...rows, ...series()]);
  const result = report.buildReport({ directory, from, to, compareFrom, compareTo: from });
  assert.deepEqual(result.comparison, {
    comparable: false,
    p95LagChangeSec: null,
    maxLagChangeSec: null,
  });
});

test('separates historic restart totals, observed increases, and counter resets', (t) => {
  const rows = series();
  for (const row of rows) row.apiFleet.totalRestartCount = 5;
  const stable = fixture(t, rows);
  assert.equal(
    report.buildReport({ directory: stable.directory, from, to }).current.status,
    'healthy',
  );
  rows.at(-1).apiFleet.totalRestartCount = 6;
  const increased = fixture(t, rows);
  const increase = report.buildReport({ directory: increased.directory, from, to }).current;
  assert.equal(increase.status, 'degraded');
  assert.equal(increase.restartCounterIncreases, 1);
  rows.at(-1).apiFleet.totalRestartCount = 0;
  const reset = fixture(t, rows);
  const changed = report.buildReport({ directory: reset.directory, from, to }).current;
  assert.equal(changed.status, 'unknown');
  assert.equal(changed.restartCounterResets, 1);
});

test('rejects excessive, reversed, malformed, timezone-free, and overlapping windows', (t) => {
  for (const [start, end] of [
    [to, from],
    [from, '2026-09-14T13:00:00Z'],
    ['2026-02-30T10:00:00Z', to],
    ['2026-09-14T10:59:00', to],
    [from, '2026-09-14T10:59:30Z'],
  ])
    assert.throws(() => report.windowBounds(start, end));
  const { directory } = fixture(t);
  assert.throws(() =>
    report.buildReport({ directory, from, to, compareFrom: from, compareTo: to }),
  );
  assert.throws(() =>
    report.buildReport({
      directory,
      from,
      to,
      compareFrom: '2026-09-14T10:57:00Z',
      compareTo: from,
    }),
  );
  assert.throws(() => report.parseArguments(['--from', from, '--from', from]));
  assert.throws(() => report.parseArguments(['__proto__', 'value']));
});

test('rejects a still-open window instead of reporting healthy future coverage', (t) => {
  const { directory } = fixture(t);
  assert.throws(
    () => reportModule.buildReport({ directory, from, to }, Date.parse(to) - 1),
    /not elapsed/u,
  );
  assert.equal(
    reportModule.buildReport({ directory, from, to }, Date.parse(to)).current.status,
    'healthy',
  );
});

test('rejects duplicate timestamps, wrong hours, oversized files, and excess record counts', (t) => {
  const duplicate = fixture(t, [...series(), series()[0]]);
  assert.throws(
    () => report.buildReport({ directory: duplicate.directory, from, to }),
    /Duplicate/u,
  );
  const wrongHour = fixture(t);
  writeFileSync(
    wrongHour.files[0],
    JSON.stringify({ schemaVersion: 1, sample: sample('2026-09-14T12:00:00Z') }),
  );
  assert.throws(
    () => report.buildReport({ directory: wrongHour.directory, from, to }),
    /hour mismatch/u,
  );
  const oversized = fixture(t);
  truncateSync(oversized.files[0], 8 * 1024 * 1024 + 1);
  assert.throws(
    () => report.buildReport({ directory: oversized.directory, from, to }),
    /oversized/u,
  );
  const crowded = fixture(
    t,
    Array.from({ length: 241 }, (_, index) =>
      sample(new Date(Date.parse(from) + index).toISOString()),
    ),
  );
  assert.throws(
    () => report.buildReport({ directory: crowded.directory, from, to }),
    /record budget/u,
  );
});

test('refuses symlinked or publicly readable archives and never creates an absent directory', (t) => {
  const data = fixture(t);
  const link = join(data.directory, 'link');
  symlinkSync(data.directory, link);
  assert.throws(() => report.buildReport({ directory: link, from, to }));
  const target = join(data.directory, 'target');
  writeFileSync(target, readFileSync(data.files[0]), { mode: 0o600 });
  rmSync(data.files[0]);
  symlinkSync(target, data.files[0]);
  assert.throws(() => report.buildReport({ directory: data.directory, from, to }));
  const publicFile = fixture(t);
  chmodSync(publicFile.files[0], 0o644);
  assert.throws(() => report.buildReport({ directory: publicFile.directory, from, to }));
  chmodSync(publicFile.directory, 0o755);
  assert.throws(() => report.buildReport({ directory: publicFile.directory, from, to }));
  const missing = join(data.directory, 'absent');
  assert.throws(() => report.buildReport({ directory: missing, from, to }));
  assert.throws(() => statSync(missing), { code: 'ENOENT' });
});

test('CLI outputs only sanitized JSON and hides malformed input from errors', (t) => {
  const cliFrom = new Date(Date.now() - 600_000).toISOString();
  const cliTo = new Date(Date.parse(cliFrom) + 300_000).toISOString();
  const { directory, files } = fixture(t, series(cliFrom));
  const args = [cli, '--archive-dir', directory, '--from', cliFrom, '--to', cliTo];
  const success = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(success.status, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).current.status, 'healthy');
  assert.doesNotMatch(success.stdout, /private-/u);
  writeFileSync(files[0], 'invalid-private-secret-contents');
  const failure = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(failure.status, 1);
  assert.equal(failure.stdout, '');
  assert.doesNotMatch(failure.stderr, /invalid-private-secret-contents/u);
});
