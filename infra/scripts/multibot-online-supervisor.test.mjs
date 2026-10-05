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

function harness(overrides = {}) {
  const child = new EventEmitter();
  child.kill = () => {};
  const signals = new EventEmitter();
  const calls = { start: [], stop: [], read: 0, capacity: 0, tick: 0 };
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
  assert.equal(h.calls.read, 1);
  assert.deepEqual(h.calls.stop, []);
  assert.equal(
    h.signals.listenerCount('SIGINT') +
      h.signals.listenerCount('SIGTERM') +
      h.signals.listenerCount('SIGHUP'),
    0,
  );
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
        throw new Error('MULTIBOT_PREPARE_MONITOR_UNAVAILABLE');
      };
    } else if (scenario === 'exhaustion') {
      expected = 'RESERVE_EXHAUSTED';
      h.options.readFilesystems = () => [{ ...filesystem, availableBytes: 10 * GiB - 1 }];
    } else if (scenario === 'deadline') {
      expected = 'DEADLINE_EXHAUSTED';
      h.options.now = () => (h.calls.tick ? 5_700_000 : 0);
    } else if (['signal during sample', 'SSH hangup'].includes(scenario)) {
      expected = 'INTERRUPTED';
      h.options.readFilesystems = async () => {
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
  const h = harness({
    readFilesystems: async () => {
      throw new Error('MULTIBOT_PREPARE_STORAGE_DEVICE_CHANGED');
    },
  });
  await assert.rejects(
    superviseMultibotOnlinePrepare(compose, h.options),
    /STORAGE_DEVICE_CHANGED/u,
  );
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
});

for (const reason of ['sessions remain', 'running container', 'probe unavailable'])
  test(`cleanup refuses unconfirmed ${reason}`, async () => {
    await assert.rejects(
      stopOwnedMigration(compose, null, tag, tag, {
        wait: async () => {},
        run: async (_command, args, options) => {
          if (reason === 'probe unavailable') throw new Error('secret');
          if (options.input === countOwnedMigrationSql)
            return { stdout: reason === 'sessions remain' ? '1' : '0' };
          return {
            stdout: args.includes('ls') && reason === 'running container' ? `${tag} running` : '',
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
