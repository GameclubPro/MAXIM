import { DelayedError } from 'bullmq';
import { PUBLISHER_DISPATCH_PAUSE_DEFER_MS } from '../publisher/publisher-dispatch-job-guard';
import { PublisherDispatchDisabledError } from '../publisher/publisher-runtime-boundary.service';
import { VkParsingSyncProcessor } from './vk-parsing-sync.processor';

describe('VkParsingSyncProcessor', () => {
  const previousRole = process.env.APP_ROLE;
  const previousServiceName = process.env.APP_SERVICE_NAME;

  beforeEach(() => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
  });

  afterEach(() => {
    jest.useRealTimers();
    if (previousRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = previousRole;
    if (previousServiceName === undefined) delete process.env.APP_SERVICE_NAME;
    else process.env.APP_SERVICE_NAME = previousServiceName;
  });

  function createFixture(dispatchEnabled = true) {
    const service = { processSyncSourceJob: jest.fn().mockResolvedValue(0) };
    const runtimeBoundary = {
      dispatchEnabled,
      assertDispatchEnabled: jest.fn(() => {
        if (!dispatchEnabled) throw new PublisherDispatchDisabledError();
      }),
    };
    const ownership = {
      getPublisherScope: () => ({ ownerProfile: 'PUBLISHER', ownerBotId: 'publisher-bot' }),
    };
    const processor = new VkParsingSyncProcessor(
      service as never,
      runtimeBoundary as never,
      ownership as never,
    );
    return { processor, runtimeBoundary, service };
  }

  function createJob(data: Record<string, unknown>) {
    return {
      data: {
        sourceId: 'source-1',
        reason: 'scheduled',
        ownerProfile: 'PUBLISHER',
        ownerBotId: 'publisher-bot',
        ...data,
      },
      attemptsMade: 0,
      opts: { attempts: 3 },
      moveToDelayed: jest.fn().mockResolvedValue(undefined),
    };
  }

  it('processes only an exact Publisher-owned sync job on api-publisher', async () => {
    const { processor, service } = createFixture();

    await expect(processor.process(createJob({}) as never, 'worker-token')).resolves.toBeUndefined();

    expect(service.processSyncSourceJob).toHaveBeenCalledWith('source-1', 'scheduled');
  });

  it.each([
    [{ ownerProfile: undefined, ownerBotId: undefined }, 'pre-scope'],
    [{ ownerProfile: 'MAJOR', ownerBotId: '' }, 'Major'],
    [{ ownerProfile: 'PUBLISHER', ownerBotId: 'another-bot' }, 'another Publisher'],
    [{ sourceId: '' }, 'missing source'],
    [{ reason: 'legacy' }, 'invalid reason'],
  ])('retires invalid sync job without execution (%s, %s)', async (data, _label) => {
    const { processor, runtimeBoundary, service } = createFixture(false);
    const job = createJob(data);

    await expect(processor.process(job as never, 'worker-token')).resolves.toBeUndefined();

    expect(job.moveToDelayed).not.toHaveBeenCalled();
    expect(runtimeBoundary.assertDispatchEnabled).not.toHaveBeenCalled();
    expect(service.processSyncSourceJob).not.toHaveBeenCalled();
  });

  it('retires malformed sync job data before the runtime delay guard', async () => {
    const { processor, runtimeBoundary, service } = createFixture(false);
    const job = createJob({});
    job.data = null as never;

    await expect(processor.process(job as never, 'worker-token')).resolves.toBeUndefined();

    expect(job.moveToDelayed).not.toHaveBeenCalled();
    expect(runtimeBoundary.assertDispatchEnabled).not.toHaveBeenCalled();
    expect(service.processSyncSourceJob).not.toHaveBeenCalled();
  });

  it('delays sync before domain execution while Publisher dispatch is disabled', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-29T12:00:00.000Z'));
    const { processor, service } = createFixture(false);
    const job = createJob({});

    await expect(processor.process(job as never, 'worker-token')).rejects.toBeInstanceOf(
      DelayedError,
    );
    expect(job.moveToDelayed).toHaveBeenCalledWith(
      Date.parse('2026-08-29T12:00:00.000Z') + PUBLISHER_DISPATCH_PAUSE_DEFER_MS,
      'worker-token',
    );
    expect(service.processSyncSourceJob).not.toHaveBeenCalled();
  });

  it('fails closed when instantiated outside api-publisher', async () => {
    process.env.APP_ROLE = 'action';
    process.env.APP_SERVICE_NAME = 'api-action';
    const { processor, runtimeBoundary, service } = createFixture();

    await expect(processor.process(createJob({}) as never)).rejects.toThrow(
      'only be consumed by api-publisher',
    );
    expect(runtimeBoundary.assertDispatchEnabled).not.toHaveBeenCalled();
    expect(service.processSyncSourceJob).not.toHaveBeenCalled();
  });
});
