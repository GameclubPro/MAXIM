import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import {
  createProfileChildEnvironment,
  createProfileFailureReport,
  expectedProfileCellCount,
  parseProfileArguments,
  validateProfileEnvironment,
} from './run-publisher-turn-profile.mjs';

test('profile defaults rollup to off and pins both rollout modes independently of ambient env', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'publisher-profile-mode-'));
  try {
    const output = join(directory, 'report.json');
    const options = parseProfileArguments(['--output', output]);
    assert.equal(options.rollupNoopMode, 'off');
    assert.equal(options.mode, 'full');
    assert.equal(options.deadlineMs, 2_700_000);
    const env = createProfileChildEnvironment(
      {
        PUBLISHER_TEMPORAL_SELECTION_ROLLOUT: '100',
        PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT: '100',
        MAXIM_PUBLISHER_TURN_PROFILE_ROLLUP_NOOP_MODE: '100',
        TZ: 'UTC',
      },
      options,
    );
    assert.equal(env.PUBLISHER_TEMPORAL_SELECTION_ROLLOUT, 'off');
    assert.equal(env.PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT, 'off');
    assert.equal(env.MAXIM_PUBLISHER_TURN_PROFILE_ROLLUP_NOOP_MODE, 'off');
    assert.equal(env.MAXIM_PUBLISHER_TURN_PROFILE_OUTPUT, output);
    assert.equal(env.TZ, 'UTC');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('projection selects exactly five cells, pins off modes and rejects conflicting selectors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'publisher-profile-projection-'));
  try {
    const output = join(directory, 'report.json');
    const options = parseProfileArguments(['--projection', '--output', output]);
    assert.equal(options.mode, 'projection');
    assert.equal(options.rollupNoopMode, 'off');
    assert.equal(options.deadlineMs, 2_700_000);
    const env = createProfileChildEnvironment(
      {
        MAXIM_PUBLISHER_TURN_PROFILE: 'full',
        PUBLISHER_TEMPORAL_SELECTION_ROLLOUT: '100',
        PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT: '100',
      },
      options,
    );
    assert.equal(env.MAXIM_PUBLISHER_TURN_PROFILE, 'projection');
    assert.equal(env.PUBLISHER_TEMPORAL_SELECTION_ROLLOUT, 'off');
    assert.equal(env.PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT, 'off');
    assert.equal(env.MAXIM_PUBLISHER_TURN_PROFILE_ROLLUP_NOOP_MODE, 'off');
    for (const selectors of [
      ['--smoke', '--projection'],
      ['--projection', '--smoke'],
      ['--projection', '--projection'],
      ['--smoke', '--smoke'],
    ])
      assert.throws(() => parseProfileArguments([...selectors, '--output', output]), /Usage:/u);
    for (const args of [
      ['--projection', '--rollup-noop-mode', '100'],
      ['--rollup-noop-mode', '100', '--projection'],
    ])
      assert.throws(() => parseProfileArguments([...args, '--output', output]), /requires.*off/u);
    assert.throws(
      () => createProfileChildEnvironment({}, { ...options, rollupNoopMode: '100' }),
      /requires.*off/u,
    );
    for (const [mode, count] of [
      ['full', 24],
      ['smoke', 7],
      ['projection', 5],
    ]) {
      assert.equal(expectedProfileCellCount(mode), count);
      const failed = createProfileFailureReport({ ...options, mode }, '2026-10-18T00:00:00Z');
      assert.equal(failed.complete, false);
      assert.equal(failed.mode, mode);
      assert.equal(failed.missingCells, count);
      assert.deepEqual(failed.configuration, { selectionMode: 'off', rollupNoopMode: 'off' });
    }
    assert.throws(() => expectedProfileCellCount('unknown'), /Unsupported/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('profile allows only an explicit off or 100 rollup comparison without changing deadlines', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'publisher-profile-mode-'));
  try {
    const output = join(directory, 'report.json');
    for (const rollupNoopMode of ['off', '100']) {
      const options = parseProfileArguments([
        '--smoke',
        '--rollup-noop-mode',
        rollupNoopMode,
        '--output',
        output,
      ]);
      assert.equal(options.rollupNoopMode, rollupNoopMode);
      assert.equal(options.mode, 'smoke');
      assert.equal(options.deadlineMs, 300_000);
      const env = createProfileChildEnvironment(
        {
          PUBLISHER_TEMPORAL_SELECTION_ROLLOUT: '25',
          PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT: 'test',
          MAXIM_PUBLISHER_TURN_PROFILE_ROLLUP_NOOP_MODE: 'test',
        },
        options,
      );
      assert.equal(env.PUBLISHER_TEMPORAL_SELECTION_ROLLOUT, 'off');
      assert.equal(env.PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT, rollupNoopMode);
      assert.equal(env.MAXIM_PUBLISHER_TURN_PROFILE_ROLLUP_NOOP_MODE, rollupNoopMode);
    }
    for (const value of ['test', '5', '25', 'on', 'OFF', ' 100', '']) {
      assert.throws(
        () => parseProfileArguments(['--rollup-noop-mode', value, '--output', output]),
        /Usage:/u,
      );
    }
    assert.throws(
      () => parseProfileArguments(['--output', output, '--rollup-noop-mode']),
      /Usage:/u,
    );
    assert.throws(
      () =>
        parseProfileArguments([
          '--rollup-noop-mode',
          'off',
          '--rollup-noop-mode',
          '100',
          '--output',
          output,
        ]),
      /Usage:/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('profile refuses production, query host overrides, ordinary local databases and non-UTC', () => {
  for (const url of [
    'postgresql://example.com/maxim_race_test_fixture',
    'postgresql://localhost/production',
    'postgresql://localhost/maxim_race_test_fixture?host=example.com',
    'postgresql://localhost/maxim_race_test_fixture?schema=public&host=example.com',
    'https://localhost/maxim_race_test_fixture',
  ])
    assert.throws(() =>
      validateProfileEnvironment({ CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL: url, TZ: 'UTC' }),
    );
  assert.throws(() =>
    validateProfileEnvironment({
      CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL: 'postgresql://localhost/maxim_race_test_fixture',
      TZ: 'Europe/Moscow',
    }),
  );
  assert.equal(
    validateProfileEnvironment({
      CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL: 'postgresql://localhost/maxim_race_test_fixture',
      TZ: 'UTC',
    }),
    'postgresql://localhost/maxim_race_test_fixture',
  );
});

test('profile accepts the exact URL shape produced by the disposable store wrapper', () => {
  const url =
    'postgresql://maxim_agent:synthetic@127.0.0.1:12345/maxim_race_test_fixture?schema=public';
  assert.equal(
    validateProfileEnvironment({ CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL: url, TZ: 'UTC' }),
    url,
  );
});

test(
  'interruption reaps the owned command group even when its npm leader exits first',
  { skip: process.platform !== 'linux', timeout: 20000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'publisher-profile-supervision-'));
    const bin = join(directory, 'bin');
    const identity = join(directory, 'child.json');
    let owned;
    let runner;
    try {
      await mkdir(bin);
      await writeFile(
        join(bin, 'npm'),
        `#!/usr/bin/env node
const {spawn}=require('node:child_process');
const {writeFileSync}=require('node:fs');
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});
child.stdout.once('data',()=>writeFileSync(process.env.PROFILE_SUPERVISION_IDENTITY,JSON.stringify({leader:process.pid,child:child.pid})));
process.on('SIGTERM',()=>process.exit(0));
setInterval(()=>{},1000);
`,
        { mode: 0o700 },
      );
      runner = spawn(
        process.execPath,
        [
          resolve(import.meta.dirname, 'run-publisher-turn-profile.mjs'),
          '--smoke',
          '--output',
          join(directory, 'report.json'),
        ],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            TZ: 'UTC',
            CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL:
              'postgresql://localhost/maxim_race_test_supervision',
            PROFILE_SUPERVISION_IDENTITY: identity,
          },
          stdio: 'ignore',
        },
      );
      const closed = once(runner, 'close', { signal: AbortSignal.timeout(12000) });
      const deadline = Date.now() + 8000;
      while (!owned && Date.now() < deadline) {
        try {
          owned = JSON.parse(await readFile(identity, 'utf8'));
        } catch {
          await delay(20);
        }
      }
      assert(owned, 'Owned descendant must be ready before interruption');
      process.kill(owned.child, 0);
      runner.kill('SIGTERM');
      const [code] = await closed;
      assert.equal(code, 1);
      let live = false;
      try {
        const stat = await readFile(`/proc/${owned.child}/stat`, 'utf8');
        live = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      assert.equal(live, false, 'An exited leader must not leave its descendant executing');
      const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
      assert.equal(report.complete, false);
      assert.deepEqual(report.configuration, { selectionMode: 'off', rollupNoopMode: 'off' });
    } finally {
      if (runner && runner.exitCode === null) runner.kill('SIGKILL');
      if (owned) {
        try {
          process.kill(-owned.leader, 'SIGKILL');
        } catch {
          /* Owned group exited. */
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
