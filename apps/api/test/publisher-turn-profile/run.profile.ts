import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { createProfileFixture, type ProfileFixture } from './fixture';
import {
  asPrismaService,
  calibrateDeliveryRows,
  explainCapturedDeliveryReads,
  ProfilePrisma,
  profileTurn,
  readProjectionEvidence,
} from './metrics';
import { createProfileRuntime, type ProfileTurn } from './runtime';

type State = 'ready' | 'future-retry' | 'verification' | 'blocked-head';
interface Cell {
  id: string;
  size: number;
  state: State;
  schedule: 'NOW' | 'ONCE';
  turn: ProfileTurn;
}

const cells: Cell[] = [];
for (const size of [64, 10000, 50000]) {
  for (const state of ['ready', 'future-retry'] as const) {
    for (const turn of ['now', 'maintenance-run', 'maintenance-pause'] as const) {
      cells.push({ id: `${state}-${size}-${turn}`, size, state, schedule: 'NOW', turn });
    }
  }
}
for (const turn of ['now', 'maintenance-run', 'maintenance-pause'] as const) {
  cells.push({
    id: `verification-50000-${turn}`,
    size: 50000,
    state: 'verification',
    schedule: 'NOW',
    turn,
  });
}
cells.push(
  {
    id: 'blocked-head-50000-now',
    size: 50000,
    state: 'blocked-head',
    schedule: 'NOW',
    turn: 'now',
  },
  { id: 'ready-50000-targeted', size: 50000, state: 'ready', schedule: 'NOW', turn: 'targeted' },
  { id: 'ready-64-deadline', size: 64, state: 'ready', schedule: 'ONCE', turn: 'deadline' },
);

const mode = process.env.MAXIM_PUBLISHER_TURN_PROFILE;
const output = process.env.MAXIM_PUBLISHER_TURN_PROFILE_OUTPUT;
const url = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL;
const rollupNoopMode = process.env.MAXIM_PUBLISHER_TURN_PROFILE_ROLLUP_NOOP_MODE;
if (!['full', 'smoke', 'projection'].includes(mode ?? '') || !output || !url) {
  throw new Error('Use the public test:publisher-full-turn-profile runner with disposable stores.');
}
if (
  (rollupNoopMode !== 'off' && rollupNoopMode !== '100') ||
  process.env.PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT !== rollupNoopMode ||
  process.env.PUBLISHER_TEMPORAL_SELECTION_ROLLOUT !== 'off' ||
  (mode === 'projection' && rollupNoopMode !== 'off')
) {
  throw new Error('Publisher profile requires explicit matching rollout modes from its runner.');
}
const runtimeOptions = Object.freeze({ rollupNoopMode });
const database = new URL(url);
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) ||
  !/^\/maxim_race_test_[a-zA-Z0-9_]+$/u.test(database.pathname) ||
  (database.search !== '' && database.search !== '?schema=public') ||
  database.hash ||
  process.env.TZ !== 'UTC'
) {
  throw new Error('Refusing non-disposable profile store');
}
const projectionCells: Cell[] = [
  ...[64, 10000, 50000].map(
    (size): Cell => ({
      id: `ready-${size}-now`,
      size,
      state: 'ready',
      schedule: 'NOW',
      turn: 'now',
    }),
  ),
  { id: 'verification-64-now', size: 64, state: 'verification', schedule: 'NOW', turn: 'now' },
  { id: 'ready-64-deadline', size: 64, state: 'ready', schedule: 'ONCE', turn: 'deadline' },
];
const selected =
  mode === 'projection'
    ? projectionCells
    : mode === 'smoke'
      ? cells.filter((cell) => cell.size === 64)
      : cells;
const expectedCells = mode === 'projection' ? 5 : mode === 'smoke' ? 7 : 24;
if (selected.length !== expectedCells) throw new Error('Incomplete Publisher profile cell matrix');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceFiles = [
  'fixture.ts',
  'runtime.ts',
  'metrics.ts',
  'run.profile.ts',
  '../../src/admin/admin-managed-broadcast-projections.ts',
  '../../src/admin/admin-managed-broadcast-runtime.ts',
  '../../src/admin/admin-managed-broadcast-planner.ts',
  '../../../../scripts/run-publisher-turn-profile.mjs',
  '../../../../scripts/run-publisher-turn-profile.test.mjs',
];
const sourceDigests = Object.fromEntries(
  sourceFiles.map((name) => [
    name,
    createHash('sha256')
      .update(readFileSync(resolve(__dirname, name)))
      .digest('hex'),
  ]),
);
type TurnMetrics = Awaited<ReturnType<typeof profileTurn>>['metrics'];
interface Sample {
  repetition: number;
  warmup: boolean;
  metrics: TurnMetrics;
  outcomes: unknown;
  counters: unknown;
}
interface CellResult {
  cell: Cell;
  status: 'missing' | 'running' | 'complete' | 'failed';
  samples: Sample[];
  setupMs?: number;
  elapsedMedianMs?: number;
  elapsedRangeMs?: [number, number];
  plans?: unknown;
  context?: ProfileFixture['context'];
  projectionEvidence?: Awaited<ReturnType<typeof readProjectionEvidence>>;
}
const report = {
  schemaVersion: 1,
  mode,
  status: 'running',
  complete: false,
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  endedAt: null as string | null,
  revision,
  sourceDigests,
  sourceDirty:
    execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  machine: {
    node: process.version,
    platform: platform(),
    kernel: release(),
    cpu: cpus()[0]?.model,
    hardwareThreads: cpus().length,
    totalMemoryBytes: totalmem(),
  },
  configuration: Object.freeze({
    poolMax: 3,
    statementTimeoutMs: 10000,
    selectionMode: 'off',
    rollupNoopMode,
    quantum: 4,
    measuredRepetitions: 3,
    warmups: 1,
    expectedCells,
    expectedPublicTurnCalls: expectedCells * 4,
    expectedControls: 7,
    expectedNativeReadPairs: mode === 'projection' ? 3 : 0,
    readyContextPaddingBytes: mode === 'projection' ? 8192 : 0,
    nativePostgres: true,
    nativeRedisCoverage: false,
    syntheticMax: true,
    population:
      'pre-materialized full snapshot targets, grants, bindings, reservations and recipients',
  }),
  limitations: [
    'Synthetic MAX transport/readiness boundary; no real HTTP/quota or client visibility.',
    'Three measurements support median/range, not production p95/p99.',
    'Occurrence and publication statistics are analyzed before each cell outside timing; unsupported statistics use the unchanged full reader.',
    'Hydrated delivery count is unobserved; SQL row count is reported separately.',
    'Delivery SQL rows include only calibrated direct SELECT shapes; captured plans replay after turn mutations and ANALYZE.',
    'Scalar probe output rows do not measure physical SQL work or delivery rows visited; native query plans establish those bounds separately.',
    'The test-only single active scope covers Prisma engine callbacks outside AsyncLocalStorage; overlapping turns are forbidden.',
    'Memory peaks are sampled; event-loop stalls can hide a peak.',
    'Projection proof resets and reads reuse the ready fixtures after timing; identical diagnostic/cell order is required across arms because later cache and process memory can be affected.',
    'Row-wise JSON bytes are exact application serialization, not PostgreSQL wire, allocation or retained heap; compression does not by itself prove external TOAST placement.',
  ],
  calibration: null as unknown,
  controls: [] as { name: string; passed: boolean }[],
  cells: selected.map((cell) => ({ cell, status: 'missing', samples: [] }) as CellResult),
  failure: null as { stage: string; name: string } | null,
};
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
function save(): void {
  report.updatedAt = new Date().toISOString();
  const temp = `${output}.tmp`;
  writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, output!);
}

test('finite native Publisher public-turn profile', async () => {
  const prisma = new ProfilePrisma(url);
  const service = asPrismaService(prisma);
  let fixture: ProfileFixture | undefined;
  let stage = 'connect';
  let executionError: Error | undefined;
  try {
    await prisma.$connect();
    stage = 'calibration';
    fixture = await createProfileFixture(service, { size: 8, state: 'ready' });
    const calibration = await calibrateDeliveryRows(service, fixture.broadcastId, 8);
    report.calibration = calibration;
    save();
    expect(calibration.directDeliverySelectProved).toBe(true);

    for (const control of ['revoke', 'cancel'] as const) {
      stage = control;
      await fixture.reset();
      const active = fixture;
      const runtime = await createProfileRuntime(active, {
        ...runtimeOptions,
        beforeSendMutation: async () => {
          if (control === 'revoke') await active.denyActorTargets();
          else await active.cancelPublication();
        },
      });
      try {
        await runtime.run('now');
        expect(runtime.snapshot().sendCount).toBe(0);
        expect(runtime.snapshot().publishAttemptCount).toBeGreaterThanOrEqual(1);
        expect(runtime.snapshot().beforeSendRejectedCount).toBeGreaterThanOrEqual(1);
        expect(
          await prisma.managedBroadcastDelivery.count({
            where: { broadcastId: active.broadcastId, status: 'SENT' },
          }),
        ).toBe(0);
        report.controls.push({ name: `final-${control}`, passed: true });
      } finally {
        await runtime.close();
      }
      save();
    }
    stage = 'fresh-denial';
    await fixture.reset();
    await fixture.setFreshDeniedHead(4);
    const denied = await createProfileRuntime(fixture, runtimeOptions);
    try {
      await denied.run('now');
      expect(denied.snapshot().sendCount).toBe(0);
      report.controls.push({ name: 'fresh-denial-zero-send', passed: true });
    } finally {
      await denied.close();
    }
    const nextSend = await prisma.managedBroadcast.findUniqueOrThrow({
      where: { id: fixture.broadcastId },
      select: { nextSendAt: true },
    });
    expect(nextSend.nextSendAt?.getTime()).toBeLessThanOrEqual(Date.now());
    const following = await createProfileRuntime(fixture, runtimeOptions);
    try {
      await following.run('now');
      expect(following.snapshot().sendCount).toBe(4);
      expect(following.snapshot().sentTargetIds).toEqual(fixture.chatIds.slice(4));
      expect(
        await prisma.managedBroadcastDelivery.count({
          where: {
            broadcastId: fixture.broadcastId,
            targetChatId: { in: fixture.chatIds.slice(0, 4) },
            status: 'PENDING',
            attemptCount: 0,
            dispatchBlockerCode: { not: null },
          },
        }),
      ).toBe(4);
      report.controls.push({ name: 'fresh-denial-next-pass-progress', passed: true });
    } finally {
      await following.close();
    }
    await fixture.cleanup();
    fixture = undefined;
    save();

    const smallControls: { state: State; turn: ProfileTurn }[] = [
      { state: 'verification', turn: 'now' },
      { state: 'blocked-head', turn: 'now' },
      { state: 'ready', turn: 'targeted' },
    ];
    for (const control of smallControls) {
      stage = `small-${control.state}-${control.turn}`;
      fixture = await createProfileFixture(service, { size: 64, state: control.state });
      const runtime = await createProfileRuntime(fixture, runtimeOptions);
      try {
        await runtime.run(control.turn);
        await fixture.assertPostconditions(control.turn, runtime.snapshot());
        report.controls.push({ name: stage, passed: true });
      } finally {
        await runtime.close();
      }
      await fixture.cleanup();
      fixture = undefined;
      save();
    }

    for (const entry of report.cells) {
      stage = entry.cell.id;
      entry.status = 'running';
      save();
      const setup = performance.now();
      fixture = await createProfileFixture(service, {
        size: entry.cell.size,
        state: entry.cell.state,
        schedule: entry.cell.schedule,
        contextPaddingBytes:
          mode === 'projection' && entry.cell.state === 'ready' && entry.cell.turn === 'now'
            ? 8192
            : 0,
      });
      // Disposable store only. Never include fixture preparation/statistics in turn timing.
      await prisma.$executeRawUnsafe('ANALYZE managed_broadcast_deliveries');
      await prisma.$executeRawUnsafe('ANALYZE managed_broadcasts');
      await prisma.$executeRawUnsafe('ANALYZE publications, publication_occurrences');
      entry.setupMs = performance.now() - setup;
      entry.context = fixture.context;
      for (let repetition = 0; repetition < 4; repetition++) {
        await fixture.reset();
        const runtime = await createProfileRuntime(fixture, runtimeOptions);
        try {
          const measured = await profileTurn(() => runtime.run(entry.cell.turn));
          const counters = runtime.snapshot();
          const { sentTargetIds, presenceMessageIds, ...scalarCounters } = counters;
          const sample: Sample = {
            repetition,
            warmup: repetition === 0,
            metrics: measured.metrics,
            counters: {
              ...scalarCounters,
              sentTargetOrdinals: sentTargetIds.map((id) => fixture!.chatIds.indexOf(id)),
              verificationTargetOrdinals: presenceMessageIds.map((id) =>
                fixture!.chatIds.indexOf(id.slice('profile-receipt-'.length)),
              ),
            },
            outcomes: null,
          };
          entry.samples.push(sample);
          save();
          if (measured.metrics.failed) {
            entry.status = 'failed';
            save();
            throw measured.failure;
          }
          expect(measured.metrics.adapterErrors).toBe(0);
          expect(counters.errorCount).toBe(0);
          sample.outcomes = await fixture.assertPostconditions(entry.cell.turn, counters);
          if (repetition === 3)
            entry.plans = await explainCapturedDeliveryReads(service, measured.captures);
          save();
          process.stdout.write(
            `${JSON.stringify({ stage, repetition, elapsedMs: measured.metrics.elapsedMs, adapterCalls: measured.metrics.adapterCalls, sqlRows: measured.metrics.returnedSqlRows })}\n`,
          );
        } finally {
          await runtime.close();
        }
      }
      const elapsed = entry.samples
        .filter((sample) => !sample.warmup)
        .map((sample) => sample.metrics.elapsedMs)
        .sort((a, b) => a - b);
      entry.elapsedMedianMs = elapsed[1];
      entry.elapsedRangeMs = [elapsed[0]!, elapsed[2]!];
      if (mode === 'projection' && entry.cell.state === 'ready' && entry.cell.turn === 'now') {
        stage = `${entry.cell.id}:native-read-pair`;
        save();
        await fixture.reset();
        entry.projectionEvidence = await readProjectionEvidence(service, fixture);
        save();
      }
      entry.status = 'complete';
      save();
      await fixture.cleanup();
      fixture = undefined;
    }
  } catch (error) {
    report.status = 'failed';
    report.failure = { stage, name: error instanceof Error ? error.name : 'UnknownError' };
    for (const entry of report.cells) if (entry.status === 'running') entry.status = 'failed';
    executionError = new Error(
      `Publisher profile failed at ${stage}; incomplete results retained in the private report.`,
    );
  } finally {
    // A timeout is enforced by terminating the child process, never by racing cleanup against SQL.
    try {
      try {
        await fixture?.cleanup();
      } finally {
        await prisma.$disconnect();
      }
      if (
        report.status === 'running' &&
        report.cells.length === expectedCells &&
        report.controls.length === 7 &&
        report.controls.every((control) => control.passed) &&
        report.cells.every(
          (entry) =>
            entry.status === 'complete' &&
            entry.samples.length === 4 &&
            entry.samples.filter((sample) => !sample.warmup).length === 3,
        ) &&
        (mode !== 'projection' ||
          report.cells.filter((entry) => entry.projectionEvidence).length === 3)
      ) {
        report.status = 'complete';
        report.complete = true;
      } else if (report.status === 'running') {
        report.status = 'failed';
        report.failure = { stage: 'completeness', name: 'IncompleteProfile' };
        executionError ??= new Error(
          'Publisher profile is missing a cell, sample, control or native read pair.',
        );
      }
    } catch (error) {
      report.status = 'failed';
      report.complete = false;
      report.failure ??= {
        stage: 'teardown',
        name: error instanceof Error ? error.name : 'UnknownError',
      };
      executionError ??= new Error(
        'Publisher profile teardown failed; incomplete results retained.',
      );
    } finally {
      report.endedAt = new Date().toISOString();
      save();
    }
  }
  if (executionError) throw executionError;
});
