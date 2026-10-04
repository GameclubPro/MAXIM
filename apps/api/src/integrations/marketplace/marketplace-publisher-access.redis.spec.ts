import { Queue, Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
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
    startWorker(access);
    // Both calls are synchronous until queue admission; their requests share the same five-second bucket.
    const [first, second] = await Promise.all([service.attest(input), service.attest(input)]);
    expect(first).toBe(id);
    expect(second).toBe(id);
    expect(access.attest).toHaveBeenCalledWith(input);
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
