import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { probeBackupReadiness } from './probe-postgres-backup-readiness.mjs';

const START = Date.parse('2026-10-15T02:44:00Z');
const snapshot = (overrides = {}) => ({
  ok: true,
  checks: {
    database: true,
    redis: true,
    queueLag: {
      rawOk: true,
      softWarning: false,
      softWarningCode: null,
      sampleGeneratedAt: new Date(START).toISOString(),
      effectiveLagSec: 2,
      oldestReceivedLagSec: 2,
      oldestQueuedLagSec: 0,
      thresholdSec: 10,
      ...overrides,
    },
  },
});
const stale = () =>
  snapshot({
    softWarning: true,
    softWarningCode: 'stale-ready-fallback',
    sampleGeneratedAt: new Date(START - 4_000).toISOString(),
  });

async function run(responses, options = {}) {
  let clock = START;
  const budgets = [];
  const reports = [];
  const waits = [];
  const passed = await probeBackupReadiness({
    timeoutMs: options.timeoutMs ?? 10_000,
    now: () => clock,
    request: async (budget) => {
      budgets.push(budget);
      clock += options.requestMs ?? 50;
      const response = responses.shift();
      assert.ok(response, 'Unexpected extra HTTP probe');
      return response.body === undefined
        ? { exitCode: 0, body: JSON.stringify(response) }
        : response;
    },
    wait: async (ms) => {
      waits.push(ms);
      clock += ms + (options.waitOverrunMs ?? 0);
    },
    emit: (report) => reports.push(report),
  });
  return { passed, budgets, waits, reports };
}

test('strict healthy observation still uses one probe without a retry', async () => {
  assert.deepEqual(await run([snapshot()]), {
    passed: true,
    budgets: [10_000],
    waits: [],
    reports: [],
  });
});

test('stale fallback requires a newer strict sample within the original deadline', async () => {
  const result = await run([
    stale(),
    snapshot({ sampleGeneratedAt: new Date(START + 2_000).toISOString() }),
  ]);
  assert.equal(result.passed, true);
  assert.deepEqual(result.budgets, [10_000, 7_700]);
  assert.deepEqual(result.waits, [2_250]);
  assert.deepEqual(result.reports[0].failures, ['queue_soft_warning']);
  assert.equal(result.reports[1].metric, 'backup_readiness_refresh_v1');
  assert.equal(result.reports[1].probes, 2);
});

test('an unchanged, old, future or missing generation never becomes fresh by clearing a flag', async () => {
  for (const sampleGeneratedAt of [
    new Date(START - 4_000).toISOString(),
    new Date(START - 3_999).toISOString(),
    new Date(START + 10_000).toISOString(),
    undefined,
    'invalid',
  ]) {
    const result = await run([stale(), snapshot({ sampleGeneratedAt })]);
    assert.equal(result.passed, false);
    assert.deepEqual(result.reports.at(-1).failures, ['refresh_not_observed_within_deadline']);
  }
});

test('persistent fallback and a real failure on recheck remain failures after at most two probes', async () => {
  for (const second of [
    stale(),
    { ...snapshot(), ok: false },
    { ...snapshot(), checks: { ...snapshot().checks, database: false } },
    { ...snapshot(), checks: { ...snapshot().checks, redis: false } },
    snapshot({ rawOk: false, effectiveLagSec: 20 }),
    { exitCode: 22, body: JSON.stringify(snapshot()) },
  ]) {
    const result = await run([stale(), second]);
    assert.equal(result.passed, false);
    assert.equal(result.budgets.length, 2);
  }
});

test('HTTP, dependency, lag, malformed and unknown-warning failures never receive a retry', async () => {
  for (const response of [
    { exitCode: 22, body: JSON.stringify(stale()) },
    { exitCode: 28, body: '' },
    { exitCode: 0, body: 'private-secret' },
    { exitCode: 0, body: 'private-secret'.repeat(6000) },
    { ...stale(), ok: false },
    { ...stale(), checks: { ...stale().checks, database: false } },
    { ...stale(), checks: { ...stale().checks, redis: false } },
    snapshot({ softWarning: true, softWarningCode: 'queue-lag-hysteresis' }),
    snapshot({ softWarning: true, softWarningCode: 'private-secret' }),
    staleWith({ rawOk: false }),
    staleWith({ effectiveLagSec: 11 }),
    staleWith({ oldestReceivedLagSec: 11 }),
    staleWith({ oldestQueuedLagSec: -1 }),
    staleWith({ thresholdSec: '10' }),
    staleWith({ sampleGeneratedAt: new Date(START + 10_000).toISOString() }),
    staleWith({ sampleGeneratedAt: new Date(START - 30_001).toISOString() }),
  ]) {
    const result = await run([response]);
    assert.equal(result.passed, false);
    assert.equal(result.budgets.length, 1);
    assert.doesNotMatch(JSON.stringify(result.reports), /private-secret|EventId|softWarningDetail/);
  }
});

function staleWith(overrides) {
  const value = stale();
  Object.assign(value.checks.queueLag, overrides);
  return value;
}

test('the probe never renews its budget after slow HTTP or timer work', async () => {
  assert.equal((await run([stale()], { timeoutMs: 2_000 })).passed, false);
  assert.equal((await run([stale()], { requestMs: 8_000 })).budgets.length, 1);
  assert.equal((await run([stale()], { waitOverrunMs: 9_000 })).budgets.length, 1);
  const firstLate = await run([snapshot()], { requestMs: 10_001 });
  assert.equal(firstLate.passed, false);
  assert.deepEqual(firstLate.reports[0].failures, ['probe_deadline']);
  const secondLate = await run(
    [stale(), snapshot({ sampleGeneratedAt: new Date(START + 3_000).toISOString() })],
    { requestMs: 4_000 },
  );
  assert.equal(secondLate.passed, false);
  assert.equal(secondLate.budgets[1], 3_750);
});

test('CLI invokes curl without a shell and never exposes response bodies or transport errors', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-ready-probe-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'curl'),
    '#!/bin/sh\nprintf "%s" "$FIXTURE_BODY"\nprintf "private-transport-secret" >&2\nexit "$FIXTURE_CODE"\n',
    { mode: 0o700 },
  );
  for (const [body, code, status] of [
    [JSON.stringify(snapshot()), '0', 0],
    ['private-secret', '22', 1],
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        new URL('./probe-postgres-backup-readiness.mjs', import.meta.url).pathname,
        'http://127.0.0.1:3001/api/health/ready',
        '10',
      ],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          FIXTURE_BODY: body,
          FIXTURE_CODE: code,
        },
        encoding: 'utf8',
        timeout: 5_000,
      },
    );
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /private-secret|private-transport-secret/);
  }
});
