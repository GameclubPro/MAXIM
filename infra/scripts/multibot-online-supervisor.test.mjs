import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  cancelOwnedMigrationSql,
  countOwnedMigrationSql,
  multibotSupervisorFailureCode,
  readMultibotMigrationFilesystems,
  runMultibotSupervisorCommand,
  stopOwnedMigration,
  superviseMultibotOnlinePrepare,
  terminateOwnedMigrationSql,
  waitForMultibotTick,
  installMultibotOutputFence,
} from './multibot-online-supervisor.mjs';

const GiB = 1024 ** 3;
const compose = [
  '--env-file',
  '.env',
  '-p',
  'infra',
  '-f',
  'infra/docker-compose.yml',
  '-f',
  'infra/docker-compose.runtime-no-build.yml',
];
const tag = 'maxim-online-aceb2e88-5369-4e3e-bdf5-1b232c3a16af';
const filesystem = { device: '/dev/shared', availableBytes: 10 * GiB, mount: '/' };
const report = {
  devices: [{ ...filesystem, roles: ['data', 'temp', 'wal', 'docker'], sufficient: true }],
  monitorPaths: { data: '/data', wal: '/wal', docker: '/var/lib/docker' },
};
const df = (device = '/dev/shared', bytes = 10 * GiB) =>
  `Filesystem 1024-blocks Used Available Capacity Mounted on\n${device} 20000000 1000 ${bytes / 1024} 40% /\n`;

const runtime = (atMs = 0, lagSec = 0) => {
  const body = {
    ok: lagSec <= 30,
    timestamp: new Date(atMs).toISOString(),
    checks: {
      database: true,
      redis: true,
      queueLag: {
        ok: lagSec <= 30,
        rawOk: lagSec <= 10,
        softWarning: lagSec > 10 && lagSec <= 30,
        softWarningCode: lagSec > 10 && lagSec <= 30 ? 'queue-lag-hysteresis' : null,
        effectiveLagSec: lagSec,
        sampleGeneratedAt: new Date(atMs).toISOString(),
      },
    },
  };
  const probe = { status: body.ok ? 200 : 503, body };
  return { checkedAtMs: atMs, ingress: probe, admin: structuredClone(probe) };
};

function harness(overrides = {}) {
  const child = new EventEmitter();
  child.kill = () => {};
  const signals = new EventEmitter();
  const calls = { start: [], stop: [], read: 0, capacity: 0, tick: 0, runtime: 0 };
  const options = {
    checkCapacity: async (args) => {
      assert.deepEqual(args, compose);
      calls.capacity += 1;
      return report;
    },
    readFilesystems: async (args, initial) => {
      assert.deepEqual(args, compose);
      assert.equal(initial, report);
      calls.read += 1;
      return [filesystem];
    },
    checkRuntime: async () => {
      calls.runtime += 1;
      return runtime();
    },
    start: (...args) => {
      calls.start.push(args);
      return child;
    },
    stop: async (...args) => {
      calls.stop.push(args);
    },
    waitForTick: async () => {
      calls.tick += 1;
      child.emit('exit', 0, null);
    },
    now: () => 0,
    signals,
    ...overrides,
  };
  return { child, signals, calls, options };
}

test('a closed SSH output pipe interrupts supervision and awaits exact owned cleanup', async () => {
  const stdout = new EventEmitter(),
    stderr = new EventEmitter();
  const h = harness({ waitForTick: async () => stdout.emit('error', new Error('EPIPE')) });
  const restore = installMultibotOutputFence({ signals: h.signals, stdout, stderr });
  try {
    await assert.rejects(superviseMultibotOnlinePrepare(compose, h.options), /INTERRUPTED/u);
    assert.equal(h.calls.start.length, 1);
    assert.equal(h.calls.stop.length, 1);
    assert.equal(h.calls.stop[0][2], h.calls.stop[0][3]);
  } finally {
    restore();
  }
  assert.equal(stdout.listenerCount('error'), 0);
  assert.equal(stderr.listenerCount('error'), 0);
});

test('attempt identity and UTC start are recorded before client creation', async () => {
  const events = [];
  const h = harness({ onAttempt: (event) => events.push(event) });
  h.options.prepare = async (name) => {
    assert.equal(events.length, 1);
    assert.equal(events[0].attemptName, name);
    assert.equal(events[0].startedAt, '1970-01-01T00:00:00.000Z');
  };
  await superviseMultibotOnlinePrepare(compose, h.options);
  assert.equal(events[0].phase, 'admission');
});

test('supervisor runs once in the complete immutable Compose scope with a matching UUID session/container tag', async () => {
  const h = harness();
  const final = await superviseMultibotOnlinePrepare(compose, h.options);
  assert.equal(final, report);
  assert.equal(h.calls.start.length, 1);
  const [command, args, options] = h.calls.start[0];
  assert.equal(command, 'docker');
  assert.deepEqual(args.slice(0, compose.length + 1), ['compose', ...compose]);
  const container = args[args.indexOf('--name') + 1];
  assert.match(
    container,
    /^maxim-online-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  assert.ok(args.includes(`MAXIM_MULTIBOT_PREPARE_APPLICATION_NAME=${container}`));
  assert.deepEqual(args.slice(-3), [
    'api-ingress',
    'node',
    'scripts/agent/multibot-online-prepare.mjs',
  ]);
  assert.ok(args.includes('--rm') && args.includes('--no-deps') && args.includes('never'));
  assert.deepEqual(options, { stdio: 'inherit' });
  assert.equal(h.calls.capacity, 2);
  assert.equal(h.calls.read, 2);
  assert.equal(h.calls.runtime, 3);
  assert.deepEqual(h.calls.stop, []);
  assert.equal(
    h.signals.listenerCount('SIGINT') +
      h.signals.listenerCount('SIGTERM') +
      h.signals.listenerCount('SIGHUP'),
    0,
  );
});

test('production default selects the awaited named client and keeps immutable Compose scope', async () => {
  const h = harness();
  delete h.options.start;
  const stages = [];
  let createdName;
  h.options.createLauncher = async (args) => {
    assert.deepEqual(args, compose);
    stages.push('factory');
    return {
      prepare: async (name) => {
        stages.push('prepare');
        createdName = name;
      },
      start: (name) => {
        stages.push('start');
        assert.equal(name, createdName);
        return h.child;
      },
    };
  };
  await superviseMultibotOnlinePrepare(compose, h.options);
  assert.deepEqual(stages, ['factory', 'prepare', 'start']);
  assert.equal(h.calls.start.length, 0);
  assert.equal(h.calls.read, 2);
  assert.equal(h.calls.runtime, 3);
});

test('default client metadata failure keeps a fixed reason and never creates work or cleanup uncertainty', async () => {
  const h = harness();
  delete h.options.start;
  h.options.createLauncher = async () => {
    throw new Error('MULTIBOT_PREPARE_CLIENT_IMAGE_INVALID');
  };
  await assert.rejects(superviseMultibotOnlinePrepare(compose, h.options), /CLIENT_IMAGE_INVALID/u);
  assert.equal(h.calls.start.length, 0);
  assert.equal(h.calls.stop.length, 0);
});

test('insufficient or unknown initial reserve never launches a migration', async () => {
  for (const devices of [
    [],
    [{ ...filesystem, availableBytes: 10 * GiB - 1 }],
    [{ ...filesystem, availableBytes: NaN }],
  ]) {
    const h = harness({ checkCapacity: () => ({ devices }) });
    await assert.rejects(
      superviseMultibotOnlinePrepare(compose, h.options),
      /CAPACITY_INSUFFICIENT/u,
    );
    assert.equal(h.calls.start.length, 0);
    assert.equal(h.calls.stop.length, 0);
  }
});

test('a created client is prepared completely before start, and a hangup while preparing never sends start', async () => {
  let finish;
  const prepared = new Promise((done) => {
    finish = done;
  });
  let entered;
  const began = new Promise((done) => {
    entered = done;
  });
  const h = harness({
    prepare: async (name) => {
      assert.match(name, /^maxim-online-/u);
      entered();
      await prepared;
    },
  });
  const result = superviseMultibotOnlinePrepare(compose, h.options);
  await began;
  h.signals.emit('SIGHUP');
  assert.equal(h.calls.start.length, 0);
  assert.equal(
    h.calls.stop.length,
    0,
    'Cleanup must wait for creation to settle before proving absence',
  );
  finish();
  await assert.rejects(result, /INTERRUPTED/u);
  assert.equal(h.calls.start.length, 0);
  assert.equal(h.calls.stop.length, 1);
  assert.equal(h.calls.stop[0][1], undefined);
  assert.equal(h.calls.stop[0][2], h.calls.stop[0][3]);
});

test('an uncertain create failure never starts work or reports confirmed cleanup', async () => {
  const h = harness({
    prepare: async () => {
      throw new Error('daemon response lost');
    },
  });
  await assert.rejects(superviseMultibotOnlinePrepare(compose, h.options), /CLEANUP_UNCONFIRMED/u);
  assert.equal(h.calls.start.length, 0);
  assert.equal(h.calls.stop.length, 1);
});

for (const scenario of [
  'lost sample',
  'exhaustion',
  'deadline',
  'signal during sample',
  'SSH hangup',
  'nonzero exit',
  'child signal',
  'spawn error',
  'throwing spawn',
  'final reserve',
  'final signal',
]) {
  test(`supervisor aborts ${scenario}, cleans only its own attempt and never retries or repairs`, async () => {
    const h = harness();
    let expected;
    h.options.waitForTick = async () => {
      h.calls.tick += 1;
      if (
        ['nonzero exit', 'child signal', 'spawn error', 'final reserve', 'final signal'].includes(
          scenario,
        )
      ) {
        if (scenario === 'spawn error') h.child.emit('error', new Error('secret-engine-error'));
        else
          h.child.emit(
            'exit',
            scenario === 'nonzero exit' ? 1 : 0,
            scenario === 'child signal' ? 'SIGTERM' : null,
          );
      }
    };
    if (scenario === 'lost sample') {
      expected = 'MONITOR_UNAVAILABLE';
      h.options.readFilesystems = () => {
        if (++h.calls.read === 1) return [filesystem];
        throw new Error('MULTIBOT_PREPARE_MONITOR_UNAVAILABLE');
      };
    } else if (scenario === 'exhaustion') {
      expected = 'RESERVE_EXHAUSTED';
      h.options.readFilesystems = () =>
        ++h.calls.read === 1 ? [filesystem] : [{ ...filesystem, availableBytes: 10 * GiB - 1 }];
    } else if (scenario === 'deadline') {
      expected = 'DEADLINE_EXHAUSTED';
      h.options.now = () => (h.calls.tick ? 5_700_000 : 0);
    } else if (['signal during sample', 'SSH hangup'].includes(scenario)) {
      expected = 'INTERRUPTED';
      h.options.readFilesystems = async () => {
        if (++h.calls.read === 1) return [filesystem];
        h.signals.emit(scenario === 'SSH hangup' ? 'SIGHUP' : 'SIGTERM');
        h.child.emit('exit', 0, null);
        return [filesystem];
      };
    } else if (scenario === 'throwing spawn') {
      expected = 'SUPERVISOR_FAILED';
      h.options.start = () => {
        throw new Error('secret-spawn-error');
      };
    } else if (scenario === 'final reserve' || scenario === 'final signal') {
      expected = scenario === 'final reserve' ? 'RESERVE_EXHAUSTED' : 'INTERRUPTED';
      h.options.checkCapacity = () => {
        h.calls.capacity += 1;
        if (h.calls.capacity === 1) return report;
        if (scenario === 'final signal') h.signals.emit('SIGINT');
        return { ...report, devices: [{ ...filesystem, availableBytes: 1 }] };
      };
    } else expected = 'PRISMA_DEPLOY_FAILED';
    await assert.rejects(
      superviseMultibotOnlinePrepare(compose, h.options),
      new RegExp(`MULTIBOT_PREPARE_${expected}`),
    );
    assert.equal(h.calls.stop.length, 1);
    const [scope, child, application, container] = h.calls.stop[0];
    assert.deepEqual(scope, compose);
    assert.equal(child, scenario === 'throwing spawn' ? undefined : h.child);
    assert.equal(application, container);
    assert.equal(
      h.signals.listenerCount('SIGINT') +
        h.signals.listenerCount('SIGTERM') +
        h.signals.listenerCount('SIGHUP'),
      0,
    );
  });
}

test('successful exit still rejects a final changed storage device or lost attestation', async () => {
  const h = harness();
  h.options.readFilesystems = async () => {
    if (++h.calls.read === 1) return [filesystem];
    throw new Error('MULTIBOT_PREPARE_STORAGE_DEVICE_CHANGED');
  };
  await assert.rejects(
    superviseMultibotOnlinePrepare(compose, h.options),
    /STORAGE_DEVICE_CHANGED/u,
  );
  assert.equal(h.calls.stop.length, 1);
});

test('runtime admission failure never creates a migration; final failure cannot accept success', async () => {
  for (const phase of ['admission', 'final']) {
    const h = harness();
    h.options.checkRuntime = async () => {
      h.calls.runtime += 1;
      return runtime(h.calls.runtime, phase === 'admission' || h.calls.runtime > 2 ? 11 : 0);
    };
    await assert.rejects(superviseMultibotOnlinePrepare(compose, h.options), {
      message: `MULTIBOT_PREPARE_RUNTIME_${phase.toUpperCase()}_BLOCKED`,
    });
    assert.equal(h.calls.start.length, phase === 'admission' ? 0 : 1);
    assert.equal(h.calls.stop.length, phase === 'admission' ? 0 : 1);
  }
});

test('runtime probes have a10s cadence inside disk supervision and pressure cancels only one attempt', async () => {
  let atMs = 0;
  const h = harness({ now: () => atMs });
  h.options.checkRuntime = async () => {
    h.calls.runtime += 1;
    return runtime(atMs, atMs >= 100_000 ? 121 : atMs >= 10_000 ? 31 : 0);
  };
  h.options.waitForTick = async (_done, ms) => {
    assert.equal(ms, 2_000);
    h.calls.tick += 1;
    atMs += ms;
  };
  await assert.rejects(superviseMultibotOnlinePrepare(compose, h.options), {
    message: 'MULTIBOT_PREPARE_RUNTIME_QUEUE_LAG',
  });
  assert.equal(atMs, 100_000);
  assert.equal(h.calls.start.length, 1);
  assert.equal(h.calls.stop.length, 1);
  assert.equal(h.calls.read, 51);
  assert.equal(h.calls.runtime, 12);
});

test('missing runtime evidence, stale fallback and dependency loss abort live attempts immediately', async () => {
  for (const failure of ['missing', 'fallback', 'dependency']) {
    let atMs = 0;
    const h = harness({ now: () => atMs });
    h.options.waitForTick = async () => {
      atMs += 10_000;
    };
    h.options.checkRuntime = async () => {
      if (atMs === 0) return runtime();
      if (failure === 'missing') throw new Error('MULTIBOT_PREPARE_RUNTIME_UNAVAILABLE');
      const sample = runtime(atMs);
      if (failure === 'fallback') {
        sample.ingress.body.checks.queueLag.softWarning = true;
        sample.ingress.body.checks.queueLag.softWarningCode = 'stale-ready-fallback';
      } else {
        sample.admin.status = 503;
        sample.admin.body.ok = false;
        sample.admin.body.checks.redis = false;
      }
      return sample;
    };
    await assert.rejects(superviseMultibotOnlinePrepare(compose, h.options), {
      message: `MULTIBOT_PREPARE_RUNTIME_${failure === 'missing' ? 'UNAVAILABLE' : failure === 'fallback' ? 'STALE' : 'NOT_READY'}`,
    });
    assert.equal(h.calls.start.length, 1);
    assert.equal(h.calls.stop.length, 1);
  }
});

test('runtime calls remain inside the original total deadline including final observation', async () => {
  let atMs = 0;
  const h = harness({ now: () => atMs });
  h.options.checkRuntime = async () => {
    h.calls.runtime += 1;
    if (h.calls.runtime === 2) atMs = 5_700_000;
    return runtime(atMs);
  };
  await assert.rejects(superviseMultibotOnlinePrepare(compose, h.options), /DEADLINE_EXHAUSTED/u);
  assert.equal(h.calls.stop.length, 1);
});

test('samples are bounded, concurrent, preserve the complete scope and attest all three devices', async () => {
  const calls = [];
  const sample = await readMultibotMigrationFilesystems(
    compose,
    report,
    async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: df() };
    },
  );
  assert.equal(sample.length, 4);
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((call) => call.args.at(-1)),
    ['/data', '/wal', '/var/lib/docker'],
  );
  for (const call of calls) {
    assert.equal(call.options.timeout, 3_000);
    if (call.command === 'docker')
      assert.deepEqual(call.args.slice(0, compose.length + 1), ['compose', ...compose]);
  }
  await assert.rejects(
    readMultibotMigrationFilesystems(compose, report, async () => ({ stdout: df('/dev/changed') })),
    /DEVICE_CHANGED/u,
  );
  await assert.rejects(
    readMultibotMigrationFilesystems(compose, report, async () => ({ stdout: 'secret malformed' })),
    /MONITOR_UNAVAILABLE/u,
  );
  await assert.rejects(
    readMultibotMigrationFilesystems(compose, report, async () => {
      throw new Error('secret');
    }),
    /MONITOR_UNAVAILABLE/u,
  );
});

test('cleanup validates exact UUID/container equality before commands or child signals', async () => {
  let calls = 0;
  for (const [application, container] of [
    ['api-ingress', 'api-ingress'],
    [tag, 'api-ingress'],
    [`${tag}\n`, `${tag}\n`],
  ])
    await assert.rejects(
      stopOwnedMigration(
        compose,
        {
          kill: () => {
            calls += 1;
          },
        },
        application,
        container,
        {
          run: () => {
            calls += 1;
          },
        },
      ),
      /IDENTITY_INVALID/u,
    );
  assert.equal(calls, 0);
});

test('cleanup kills its launcher, cancels, stops only its container and verifies session disappearance after termination', async () => {
  const calls = [];
  let observations = 0;
  const child = {
    kill: (signal) => {
      calls.push({ kill: signal });
    },
  };
  await stopOwnedMigration(compose, child, tag, tag, {
    wait: async () => {},
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      if (args.includes('psql')) {
        assert.deepEqual(args.slice(0, compose.length + 1), ['compose', ...compose]);
        assert.ok(args.includes(`owned_application_name=${tag}`));
        assert.match(options.input, /datname = current_database\(\) AND usename = current_user/u);
        assert.match(options.input, /application_name = :'owned_application_name'/u);
        assert.match(options.input, /statement_timeout = '2s'/u);
        if (options.input === countOwnedMigrationSql)
          return { stdout: String(++observations === 1 ? 1 : 0) };
      }
      if (args[0] === 'stop') assert.deepEqual(args, ['stop', '--time', '3', tag]);
      if (args[0] === 'rm') assert.deepEqual(args, ['rm', '--force', tag]);
      return { stdout: '' };
    },
  });
  assert.deepEqual(calls[0], { kill: 'SIGKILL' });
  assert.equal(calls.filter((call) => call.options?.input === cancelOwnedMigrationSql).length, 1);
  assert.equal(
    calls.filter((call) => call.options?.input === terminateOwnedMigrationSql).length,
    2,
  );
  assert.equal(observations, 2);
  assert.equal(calls.filter((call) => call.args?.[0] === 'rm').length, 1);
});

for (const reason of [
  'sessions remain',
  'running container',
  'created container',
  'exited container',
  'probe unavailable',
])
  test(`cleanup refuses unconfirmed ${reason}`, async () => {
    await assert.rejects(
      stopOwnedMigration(compose, null, tag, tag, {
        wait: async () => {},
        run: async (_command, args, options) => {
          if (reason === 'probe unavailable') throw new Error('secret');
          if (options.input === countOwnedMigrationSql)
            return { stdout: reason === 'sessions remain' ? '1' : '0' };
          return {
            stdout:
              args.includes('ls') && reason.endsWith(' container')
                ? `${tag} ${reason.split(' ')[0]}`
                : '',
          };
        },
      }),
      /CLEANUP_UNCONFIRMED/u,
    );
  });

test('command runner sends actual stdin, closes it and bounds an unresponsive command', async () => {
  const value = 'BEGIN;\nSELECT 1;\nCOMMIT;';
  const result = await runMultibotSupervisorCommand(
    process.execPath,
    ['-e', 'process.stdin.pipe(process.stdout)'],
    { input: value },
  );
  assert.equal(result.stdout, value);
  await assert.rejects(
    runMultibotSupervisorCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      timeout: 50,
    }),
    (error) => error.killed,
  );
  await waitForMultibotTick(Promise.resolve(), 10_000);
});

test('failure reporting allows only fixed codes and never includes free-form secret suffixes', () => {
  assert.equal(
    multibotSupervisorFailureCode(new Error('MULTIBOT_PREPARE_MONITOR_UNAVAILABLE')),
    'MULTIBOT_PREPARE_MONITOR_UNAVAILABLE',
  );
  for (const secret of [
    'postgres://secret',
    'MULTIBOT_PREPARE_MONITOR_UNAVAILABLE secret',
    'MULTIBOT_secret',
  ])
    assert.equal(
      multibotSupervisorFailureCode(new Error(secret)),
      'MULTIBOT_PREPARE_SUPERVISOR_FAILED',
    );
});
