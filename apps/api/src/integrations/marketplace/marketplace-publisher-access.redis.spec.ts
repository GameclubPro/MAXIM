import { Queue, QueueEvents, Scripts, Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import type Redis from 'ioredis';
import { MarketplacePublisherAccessProcessor } from './marketplace-publisher-access.processor';
import {
  MarketplacePublisherAccessQueueService,
  type MarketplacePublisherAccessJob,
  type MarketplacePublisherAccessResult,
} from './marketplace-publisher-access.queue';
import type { MarketplaceAccessService } from './marketplace-access.service';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL ?? '';
const integration = redisUrl ? describe : describe.skip;
const input = {
  actorUserId: '323459159',
  entityId: '-100',
  kind: 'CHANNEL',
  profile: 'publisher',
} as const;
async function waitForStage<T>(stage: string, operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${stage} test stage timed out`)), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
jest.setTimeout(30000);
integration('marketplace Publisher request/reply with isolated Redis', () => {
  const previousRole = process.env.APP_ROLE,
    previousService = process.env.APP_SERVICE_NAME;
  let queue: Queue<MarketplacePublisherAccessJob, MarketplacePublisherAccessResult>;
  let service: MarketplacePublisherAccessQueueService;
  let worker: Worker<MarketplacePublisherAccessJob, MarketplacePublisherAccessResult> | undefined;
  let options: { prefix: string; connection: { host: string; port: number } };
  beforeEach(async () => {
    const url = new URL(redisUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname))
      throw new Error('Isolated local Redis required');
    options = {
      prefix: `marketplace-test-${randomUUID()}`,
      connection: { host: url.hostname, port: Number(url.port) },
    };
    queue = new Queue('marketplace-publisher-access', options);
    service = new MarketplacePublisherAccessQueueService(queue);
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
  });
  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    await service.onModuleDestroy();
    await queue.obliterate({ force: true });
    await queue.close();
    if (previousRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = previousRole;
    if (previousService === undefined) delete process.env.APP_SERVICE_NAME;
    else process.env.APP_SERVICE_NAME = previousService;
  });
  const startWorker = (access: { attest: jest.Mock }) => {
    const processor = new MarketplacePublisherAccessProcessor(
      access as unknown as MarketplaceAccessService,
    );
    worker = new Worker('marketplace-publisher-access', (job) => processor.process(job), options);
  };

  it('returns the exact worker binding and coalesces duplicate requests without any credential payload', async () => {
    const id = randomUUID();
    const access = { attest: jest.fn().mockResolvedValue({ id }) };
    const client = await queue.client;
    const oldReply = {
      event: 'completed',
      jobId: 'old-job',
      returnvalue: JSON.stringify({
        state: 'ACTIVE',
        bindingId: randomUUID(),
      }),
    };
    await client.xadd(queue.toKey('events'), '*', oldReply);
    const previousTail = await client.xadd(queue.toKey('events'), '*', oldReply);
    const tailClient = client as unknown as Pick<Redis, 'xrevrange'>;
    const originalTailRead = tailClient.xrevrange;
    const tailRead = jest.fn((...args: [string, string, string, 'COUNT', number]) =>
      originalTailRead(...args),
    );
    tailClient.xrevrange = tailRead as unknown as typeof originalTailRead;
    startWorker(access);
    try {
      // Both calls are synchronous until queue admission; their requests share the same five-second bucket.
      const [first, second] = await Promise.all([service.attest(input), service.attest(input)]);
      expect(first).toBe(id);
      expect(second).toBe(id);
      expect(access.attest).toHaveBeenCalledWith(input);
      expect(tailRead).toHaveBeenCalledTimes(1);
      expect(tailRead).toHaveBeenCalledWith(queue.toKey('events'), '+', '-', 'COUNT', 1);
      const tail = await tailRead.mock.results[0]!.value;
      expect(tail).toHaveLength(1);
      const [cursorMs, cursorSequence] = tail[0]![0].split('-').map(BigInt);
      const [seedMs, seedSequence] = previousTail.split('-').map(BigInt);
      expect(cursorMs! > seedMs! || (cursorMs === seedMs && cursorSequence! >= seedSequence!)).toBe(
        true,
      );
      const jobs = await queue.getJobs(['completed']);
      expect(jobs.length).toBeGreaterThanOrEqual(1);
      expect(jobs.length).toBeLessThanOrEqual(2);
      for (const job of jobs) {
        expect(Object.keys(job.data).sort()).toEqual([
          'actorUserId',
          'entityId',
          'kind',
          'profile',
          'requestedAtMs',
        ]);
        expect(job.opts.removeOnComplete).toEqual({ age: 30, count: 100 });
      }
    } finally {
      tailClient.xrevrange = originalTailRead;
    }
  });

  it('receives a committed reply when the first event read starts after the unfinished-state poll', async () => {
    const id = randomUUID();
    let releaseEvents!: () => void;
    const eventsBarrier = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });
    let releaseAccess!: () => void;
    const accessBarrier = new Promise<void>((resolve) => {
      releaseAccess = resolve;
    });
    let recordUnfinished!: () => void;
    const unfinished = new Promise<void>((resolve) => {
      recordUnfinished = resolve;
    });
    const originalRun = QueueEvents.prototype.run;
    const originalIsFinished = Scripts.prototype.isFinished;
    // FLAG: Keep the real connection ready while holding the first XREAD. The real
    // unfinished-state poll and completed Redis receipt must precede subscription.
    const eventRead = jest.spyOn(QueueEvents.prototype, 'run').mockImplementation(async function (
      this: QueueEvents,
    ) {
      await eventsBarrier;
      return originalRun.call(this);
    });
    const poll = jest.spyOn(Scripts.prototype, 'isFinished').mockImplementation(async function (
      this: Scripts,
      ...args
    ) {
      const result = await originalIsFinished.apply(this, args);
      if (Array.isArray(result) && result[0] === 0) recordUnfinished();
      return result;
    });
    const access = {
      attest: jest.fn().mockImplementation(async () => {
        await accessBarrier;
        return { id };
      }),
    };
    startWorker(access);
    await worker!.waitUntilReady();
    const completed = new Promise<{ error?: Error }>((resolve) => {
      worker!.once('completed', () => resolve({}));
      worker!.once('failed', (_job, error) => resolve({ error }));
    });
    const decision = service.attest(input).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await waitForStage('unfinished Redis poll', unfinished);
      releaseAccess();
      expect(await waitForStage('completed Redis receipt', completed)).toEqual({});
      const jobs = await queue.getJobs(['completed']);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.returnvalue).toEqual({ state: 'ACTIVE', bindingId: id });
      expect(access.attest).toHaveBeenCalledTimes(1);
      releaseEvents();
      expect(await decision).toEqual({ value: id });
    } finally {
      releaseAccess();
      releaseEvents();
      await decision;
      poll.mockRestore();
      eventRead.mockRestore();
    }
  });

  it('fails closed when a worker is accidentally started in the action role', async () => {
    process.env.APP_ROLE = 'action';
    process.env.APP_SERVICE_NAME = 'api-action';
    const access = { attest: jest.fn() };
    startWorker(access);
    await expect(service.attest(input)).rejects.toThrow(ServiceUnavailableException);
    expect(access.attest).not.toHaveBeenCalled();
    const jobs = await queue.getJobs(['failed']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.attemptsMade).toBe(1);
  });

  it('times out without granting access and expires the queued request before later execution', async () => {
    const access = { attest: jest.fn() };
    const started = Date.now();
    await expect(service.attest(input)).rejects.toThrow('Проверяем права');
    expect(Date.now() - started).toBeGreaterThanOrEqual(7900);
    startWorker(access);
    const completed = new Promise<void>((resolve, reject) => {
      worker!.once('completed', () => resolve());
      worker!.once('failed', (_job, error) => reject(error));
    });
    await completed;
    expect(access.attest).not.toHaveBeenCalled();
    const jobs = await queue.getJobs(['completed']);
    expect(jobs[0]?.returnvalue).toEqual({ state: 'RETRY' });
  });
});
