import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  createMultibotHarness,
  MULTIBOT_HARNESS_POOLS,
  type MultibotHarness,
  type MultibotHarnessOptions,
  type MultibotHarnessRole,
  type SimulatedMaxEffect,
} from './webhook-multibot-fullpath.spec-support';

export type SplitRoleReport = {
  role: MultibotHarnessRole;
  pid: number;
  sqlPoolMax: number;
  effects: SimulatedMaxEffect[];
  requests: SimulatedMaxEffect[];
  processedQueues: Record<string, number>;
  cpu: NodeJS.CpuUsage;
  maxRssKiB: number;
  failed: boolean;
};

// FLAG: These processes use only disposable local stores and the in-memory MAX
// adapter. They never inherit production credentials or open a MAX connection.
export async function createSplitMultibotHarness(options: MultibotHarnessOptions) {
  const runId = randomUUID();
  const owner = await createMultibotHarness({
    ...options,
    split: { runId, role: 'api-ingress' },
  });
  const peers: Array<{
    child: ChildProcess;
    role: MultibotHarnessRole;
    rpc: (command: 'report' | 'stop') => Promise<SplitRoleReport | undefined>;
    done: Promise<void>;
    stopping: boolean;
  }> = [];
  const roleReports: SplitRoleReport[] = [];
  const effects: SimulatedMaxEffect[] = [];
  const requests: SimulatedMaxEffect[] = [];
  let failure: Error | undefined;
  let closed = false;
  const assertHealthy = () => {
    if (failure) throw failure;
  };

  async function start(role: MultibotHarnessRole) {
    const child = fork(join(__dirname, '../scripts/loadtest-multibot-role.ts'), [], {
      execArgv: ['--import', 'tsx'],
      env: {
        PATH: process.env.PATH,
        TZ: 'UTC',
        NODE_ENV: 'test',
        APP_SERVICE_NAME: role,
        APP_ROLE:
          role === 'api-enqueue' ? 'enqueue' : role === 'api-action' ? 'action' : 'moderation',
        PRISMA_PG_POOL_MAX: String(MULTIBOT_HARNESS_POOLS[role]),
        PRISMA_PG_POOL_CONNECTION_TIMEOUT_MS: '5000',
        PRISMA_PG_POOL_IDLE_TIMEOUT_MS: '10000',
        ENQUEUE_BATCH_SIZE: '400',
        ENQUEUE_CONCURRENCY: '32',
        ENQUEUE_POLL_INTERVAL_MS: '200',
      },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const pending = new Map<
      string,
      {
        resolve: (report: SplitRoleReport | undefined) => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
      }
    >();
    const rejectAll = (error: Error) => {
      readyReject(error);
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      pending.clear();
    };
    const peer = {
      child,
      role,
      stopping: false,
      done: new Promise<void>((resolve) => child.once('exit', () => resolve())),
      rpc: (command: 'report' | 'stop') =>
        new Promise<SplitRoleReport | undefined>((resolve, reject) => {
          const id = randomUUID();
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Split fixture ${role} ${command} timed out`));
          }, 30_000);
          pending.set(id, { resolve, reject, timer });
          child.send({ command, id }, (error) => {
            if (error) {
              pending.delete(id);
              clearTimeout(timer);
              reject(error);
            }
          });
        }),
    };
    peers.push(peer);
    child.on('error', (error) => {
      failure ??= error;
      rejectAll(error);
    });
    child.on('exit', (code) => {
      if (!peer.stopping || code !== 0)
        failure ??= new Error(`Split fixture ${role} exited ${code}`);
      rejectAll(failure ?? new Error(`Split fixture ${role} stopped`));
    });
    child.on('message', (message: { kind?: string; id?: string; report?: SplitRoleReport }) => {
      if (message.kind === 'ready') readyResolve();
      if (message.kind === 'failed') {
        failure ??= new Error(`Split fixture ${role} failed; see its local diagnostic`);
        rejectAll(failure);
      }
      if (message.kind === 'reply' && message.id) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        request.resolve(message.report);
      }
    });
    const readyTimeout = setTimeout(
      () => readyReject(new Error(`Split fixture ${role} did not start`)),
      60_000,
    );
    child.send({ command: 'start', options: { ...options, split: { runId, role } } });
    try {
      await ready;
    } finally {
      clearTimeout(readyTimeout);
    }
  }

  async function collectReports(allowFailed = false) {
    if (!allowFailed) assertHealthy();
    const results = await Promise.allSettled(peers.map((peer) => peer.rpc('report')));
    const reports = results.flatMap((result) =>
      result.status === 'fulfilled' && result.value ? [result.value] : [],
    );
    const complete = reports.length === peers.length;
    if (!allowFailed && (!complete || reports.some((report) => report.failed)))
      throw new Error('Split fixture role report is incomplete or failed');
    roleReports.splice(
      0,
      roleReports.length,
      ...reports.filter((report): report is SplitRoleReport => !!report),
    );
    roleReports.unshift({
      role: 'api-ingress',
      pid: process.pid,
      sqlPoolMax: owner.capacity.sqlPoolMax,
      effects: owner.effects,
      requests: owner.requests,
      processedQueues: Object.fromEntries(owner.processedQueues),
      cpu: process.cpuUsage(),
      maxRssKiB: process.resourceUsage().maxRSS,
      failed: !!owner.failures.length,
    });
    // Child reports are cumulative; replace their previous contribution after each
    // closed profile so the ordinary final effect assertions cover all processes.
    effects.length = 0;
    requests.length = 0;
    for (const report of roleReports) {
      for (const effect of report.effects) effects.push(effect);
      for (const request of report.requests) requests.push(request);
    }
    if (!allowFailed) assertHealthy();
    return complete;
  }

  async function dispose() {
    if (closed) return;
    closed = true;
    const stop = async (peer: (typeof peers)[number]) => {
      if (peer.child.exitCode !== null || peer.child.signalCode !== null) return;
      peer.stopping = true;
      try {
        await peer.rpc('stop');
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error('Split fixture shutdown failed');
        peer.child.kill('SIGKILL');
      }
      await peer.done;
    };
    // Stop admission and await its in-flight work before stopping consumers. Only
    // after every child is reaped may the parent remove its disposable fixtures.
    for (const peer of peers.filter((item) => item.role === 'api-enqueue')) await stop(peer);
    await Promise.all(peers.filter((item) => item.role !== 'api-enqueue').map(stop));
    await owner.dispose();
    assertHealthy();
  }

  try {
    for (const role of Object.keys(MULTIBOT_HARNESS_POOLS) as MultibotHarnessRole[]) {
      if (role !== 'api-ingress') await start(role);
    }
  } catch (error) {
    await dispose().catch(() => undefined);
    throw error;
  }
  return {
    ...owner,
    effects,
    requests,
    roleReports,
    snapshotEffects: () => collectReports(true),
    capacity: { ...owner.capacity, preparationPoolMax: 24, enqueueConcurrency: 32 },
    pumpWork: async () => {
      assertHealthy();
    },
    drain: async (maxMs = 60_000) => {
      const deadline = Date.now() + maxMs;
      while (Date.now() < deadline) {
        assertHealthy();
        if (!(await owner.pumpOnce())) {
          await collectReports();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      await collectReports();
      throw new Error(`Split fixture drain exceeded ${maxMs} ms`);
    },
    dispose,
  } satisfies MultibotHarness & {
    roleReports: SplitRoleReport[];
    snapshotEffects: () => Promise<boolean>;
  };
}
