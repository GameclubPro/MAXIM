import { ConfigService } from '@nestjs/config';
import { MAX_ACTION_ALL_QUEUE_NAMES } from '../max/max-action.queue';
import { getDefaultWebhookWorkerGroupQueues } from '../runtime/moderation-runtime';
import { DEFAULT_WEBHOOK_QUEUE_NAMES } from '../webhook/webhook-queues';
import { BackgroundRuntimeGovernorService } from './background-runtime-governor.service';
import type { QueueCounters } from './queue-metrics.service';

type PressureSnapshot = Awaited<
  ReturnType<BackgroundRuntimeGovernorService['getPressureSnapshot']>
>;

export function createRecoveryGovernorFixture(config = new ConfigService()) {
  const counters: QueueCounters = {
    waiting: 0,
    active: 0,
    delayed: 0,
    failed: 0,
    completed: 0,
    prioritized: 0,
  };
  const indexed = <K extends string, V>(keys: readonly K[], value: (key: K) => V) =>
    Object.fromEntries(keys.map((key) => [key, value(key)])) as Record<K, V>;
  const groups = getDefaultWebhookWorkerGroupQueues();
  const snapshot: PressureSnapshot = {
    generatedAt: new Date().toISOString(),
    mode: {
      mode: 'degrade',
      source: 'auto',
      condition: 'stabilizing',
      reason: 'recovery window in progress',
      updatedAt: new Date().toISOString(),
      manualMode: null,
      queueLagSec: 0,
      action: {
        windowSec: 60,
        total: 0,
        success: 0,
        failure: 0,
        critical: 0,
        errorRate: 0,
        criticalRate: 0,
      },
    },
    queues: {
      generatedAt: new Date().toISOString(),
      oldestQueuedEventId: null,
      oldestQueuedCreatedAt: null,
      oldestQueuedLagSec: 0,
      oldestReceivedEventId: null,
      oldestReceivedCreatedAt: null,
      oldestReceivedLagSec: 0,
      effectiveLagSec: 0,
      operationalLagSec: 0,
      webhookDefaultShards: indexed(DEFAULT_WEBHOOK_QUEUE_NAMES, () => ({ ...counters })),
      webhookDefaultWorkerGroups: indexed(
        Object.keys(groups) as (keyof typeof groups)[],
        (key) => ({ queues: [...groups[key]], counters: { ...counters } }),
      ),
      actions: { ...counters },
      actionQueues: indexed(MAX_ACTION_ALL_QUEUE_NAMES, () => ({ ...counters })),
    },
    backgroundShare: 0,
    systemPressure: {
      enabled: true,
      loadAverage1m: 1,
      loadRatio1m: 0.1,
      cpuCount: 10,
      ioWaitRatio: 0,
      sampleWindowMs: 1_000,
      thresholds: { loadSlow: 0.85, loadPause: 1.25, ioWaitSlow: 0.15, ioWaitPause: 0.35 },
    },
    stackLoad: {
      windowSec: 60,
      smoothedLoad: 0,
      peakLoad: 0,
      avgLoad: 0,
      slowThreshold: 0.35,
      pauseThreshold: 0.7,
    },
    botLoad: {
      maxSmoothedLoad: 0,
      maxPeakLoad: 0,
      slowThreshold: 0.35,
      pauseThreshold: 0.7,
      topBots: [],
    },
    criticalLimiter: null,
    workerSkew: { groupName: null, pressure: 0, totalPressure: 0, share: 0 },
  };
  const governor = new BackgroundRuntimeGovernorService(
    {} as never,
    { getEffectiveSnapshot: async () => snapshot.mode } as never,
    {} as never,
    config,
  );
  // FLAG: Only pressure measurements are controlled. The real governor and scheduler
  // still decide admission; this fixture grants no MAX or database execution authority.
  jest
    .spyOn(
      governor as unknown as { getPressureSnapshot: () => Promise<PressureSnapshot> },
      'getPressureSnapshot',
    )
    .mockImplementation(async () => snapshot);
  return { governor, snapshot };
}
