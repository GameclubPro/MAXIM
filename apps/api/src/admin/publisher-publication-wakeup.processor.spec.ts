import type { Job } from 'bullmq';
import { PublisherDispatchDisabledError } from '../publisher/publisher-runtime-boundary.service';
import { PublisherPublicationWakeupProcessor } from './publisher-publication-wakeup.processor';
import {
  buildPublisherPublicationWakeupJobId,
  PUBLISHER_PUBLICATION_WAKEUP_JOB,
  PUBLISHER_PUBLICATION_WAKEUP_JOB_TTL_MS,
  type PublisherPublicationWakeupJob,
} from './publisher-publication-wakeup.queue';

describe('PublisherPublicationWakeupProcessor', () => {
  const originalRole = process.env.APP_ROLE;
  const originalServiceName = process.env.APP_SERVICE_NAME;
  const now = new Date('2026-09-04T12:00:00.000Z');
  const idempotencyKey = buildPublisherPublicationWakeupJobId('publication-1', 'mutation-1');
  const ordinaryData: PublisherPublicationWakeupJob = {
    version: 1,
    kind: 'materialize_publication',
    publicationId: 'publication-1',
    occurrenceId: null,
    reason: 'update',
    idempotencyKey,
    retryPolicyName: 'publisher-publication-wakeup',
    createdAt: now.toISOString(),
  };

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = originalRole;
    if (originalServiceName === undefined) delete process.env.APP_SERVICE_NAME;
    else process.env.APP_SERVICE_NAME = originalServiceName;
  });

  function fixture(
    params: {
      runtimeBoundary?: { assertDispatchEnabled: jest.Mock };
      identityAttestation?: { assertAttested: jest.Mock };
      dispatchHealth?: { assertDispatchAllowed: jest.Mock };
      publicationService?: { processPublisherPublicationWake: jest.Mock };
      publicationRunner?: { wakeAfterPublicationMaterialization: jest.Mock };
    } = {},
  ) {
    const runtimeBoundary =
      params.runtimeBoundary ?? ({ assertDispatchEnabled: jest.fn() } as const);
    const identityAttestation =
      params.identityAttestation ??
      ({ assertAttested: jest.fn().mockResolvedValue(undefined) } as const);
    const dispatchHealth =
      params.dispatchHealth ??
      ({ assertDispatchAllowed: jest.fn().mockResolvedValue(undefined) } as const);
    const publicationService =
      params.publicationService ??
      ({ processPublisherPublicationWake: jest.fn().mockResolvedValue(undefined) } as const);
    const publicationRunner =
      params.publicationRunner ??
      ({ wakeAfterPublicationMaterialization: jest.fn().mockResolvedValue(undefined) } as const);

    return {
      processor: new PublisherPublicationWakeupProcessor(
        publicationService as never,
        publicationRunner as never,
        runtimeBoundary as never,
        identityAttestation as never,
        dispatchHealth as never,
      ),
      runtimeBoundary,
      identityAttestation,
      dispatchHealth,
      publicationService,
      publicationRunner,
    };
  }

  function job(
    data: unknown = ordinaryData,
    overrides: Record<string, unknown> = {},
  ): Job<PublisherPublicationWakeupJob> {
    return {
      id: idempotencyKey,
      name: PUBLISHER_PUBLICATION_WAKEUP_JOB,
      data,
      timestamp: now.getTime(),
      ...overrides,
    } as Job<PublisherPublicationWakeupJob>;
  }

  it.each([
    ['action', 'api-action'],
    ['publisher', 'api-admin'],
  ])('rejects queue consumption for role %s in service %s', async (role, serviceName) => {
    process.env.APP_ROLE = role;
    process.env.APP_SERVICE_NAME = serviceName;
    const { processor, publicationService } = fixture();

    await expect(processor.process(job())).rejects.toThrow('may only be consumed by api-publisher');
    expect(publicationService.processPublisherPublicationWake).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong job name', ordinaryData, { name: 'another-job' }],
    ['job id mismatch', ordinaryData, { id: 'another-id' }],
    ['invalid envelope', { ...ordinaryData, retryPolicyName: 'another-policy' }, {}],
    [
      'retry without occurrence identity',
      { ...ordinaryData, reason: 'retry', occurrenceId: null },
      {},
    ],
    [
      'resolution without occurrence identity',
      { ...ordinaryData, reason: 'resolution', occurrenceId: null },
      {},
    ],
  ])('rejects %s before guards or domain work', async (_label, data, overrides) => {
    const {
      processor,
      runtimeBoundary,
      identityAttestation,
      dispatchHealth,
      publicationService,
      publicationRunner,
    } = fixture();

    await expect(processor.process(job(data, overrides))).rejects.toThrow(
      /wakeup (?:job(?: identity)?|occurrence scope) is invalid/,
    );

    expect(runtimeBoundary.assertDispatchEnabled).not.toHaveBeenCalled();
    expect(identityAttestation.assertAttested).not.toHaveBeenCalled();
    expect(dispatchHealth.assertDispatchAllowed).not.toHaveBeenCalled();
    expect(publicationService.processPublisherPublicationWake).not.toHaveBeenCalled();
    expect(publicationRunner.wakeAfterPublicationMaterialization).not.toHaveBeenCalled();
  });

  it('drops an expired signal before guards or database access', async () => {
    const {
      processor,
      runtimeBoundary,
      identityAttestation,
      dispatchHealth,
      publicationService,
      publicationRunner,
    } = fixture();
    const expiredData = {
      ...ordinaryData,
      createdAt: new Date(now.getTime() - PUBLISHER_PUBLICATION_WAKEUP_JOB_TTL_MS).toISOString(),
    };

    await expect(processor.process(job(expiredData))).resolves.toBeUndefined();

    expect(runtimeBoundary.assertDispatchEnabled).not.toHaveBeenCalled();
    expect(identityAttestation.assertAttested).not.toHaveBeenCalled();
    expect(dispatchHealth.assertDispatchAllowed).not.toHaveBeenCalled();
    expect(publicationService.processPublisherPublicationWake).not.toHaveBeenCalled();
    expect(publicationRunner.wakeAfterPublicationMaterialization).not.toHaveBeenCalled();
  });

  it('runs runtime, identity and health guards before materialization and runner wake', async () => {
    const order: string[] = [];
    const { processor } = fixture({
      runtimeBoundary: {
        assertDispatchEnabled: jest.fn(() => {
          order.push('runtime');
        }),
      },
      identityAttestation: {
        assertAttested: jest.fn(async () => {
          order.push('identity');
        }),
      },
      dispatchHealth: {
        assertDispatchAllowed: jest.fn(async () => {
          order.push('health');
        }),
      },
      publicationService: {
        processPublisherPublicationWake: jest.fn(async () => {
          order.push('materialize');
        }),
      },
      publicationRunner: {
        wakeAfterPublicationMaterialization: jest.fn(async () => {
          order.push('wake');
        }),
      },
    });

    await processor.process(job());

    expect(order).toEqual(['runtime', 'identity', 'health', 'materialize', 'wake']);
  });

  it('does not pass later guards or database work when the runtime is disabled', async () => {
    const runtimeBoundary = {
      assertDispatchEnabled: jest.fn(() => {
        throw new PublisherDispatchDisabledError();
      }),
    };
    const {
      processor,
      identityAttestation,
      dispatchHealth,
      publicationService,
      publicationRunner,
    } = fixture({ runtimeBoundary });
    const moveToDelayed = jest.fn().mockResolvedValue(undefined);

    await expect(
      processor.process(job(ordinaryData, { moveToDelayed }), 'worker-token'),
    ).rejects.toBeDefined();

    expect(moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'worker-token');
    expect(identityAttestation.assertAttested).not.toHaveBeenCalled();
    expect(dispatchHealth.assertDispatchAllowed).not.toHaveBeenCalled();
    expect(publicationService.processPublisherPublicationWake).not.toHaveBeenCalled();
    expect(publicationRunner.wakeAfterPublicationMaterialization).not.toHaveBeenCalled();
  });

  it.each(['create', 'update', 'resume'] as const)(
    'materializes an ordinary %s signal without past or occurrence scope',
    async (reason) => {
      const { processor, publicationService, publicationRunner } = fixture();

      await processor.process(job({ ...ordinaryData, reason }));

      expect(publicationService.processPublisherPublicationWake).toHaveBeenCalledWith(
        'publication-1',
        {
          allowPastScheduled: false,
          occurrenceId: undefined,
        },
      );
      expect(publicationRunner.wakeAfterPublicationMaterialization).toHaveBeenCalledWith(
        'publication-1',
        undefined,
      );
    },
  );

  it.each(['retry', 'resolution'] as const)(
    'materializes only the exact %s occurrence with past scheduling allowed',
    async (reason) => {
      const { processor, publicationService, publicationRunner } = fixture();
      const retryData: PublisherPublicationWakeupJob = {
        ...ordinaryData,
        reason,
        occurrenceId: 'occurrence-7',
      };

      await processor.process(job(retryData));

      expect(publicationService.processPublisherPublicationWake).toHaveBeenCalledWith(
        'publication-1',
        {
          allowPastScheduled: true,
          occurrenceId: 'occurrence-7',
        },
      );
      expect(publicationRunner.wakeAfterPublicationMaterialization).toHaveBeenCalledWith(
        'publication-1',
        'occurrence-7',
      );
    },
  );

  it('does not wake the runner when targeted materialization fails', async () => {
    const failure = new Error('database unavailable');
    const publicationService = {
      processPublisherPublicationWake: jest.fn().mockRejectedValue(failure),
    };
    const { processor, publicationRunner } = fixture({ publicationService });

    await expect(processor.process(job())).rejects.toBe(failure);

    expect(publicationRunner.wakeAfterPublicationMaterialization).not.toHaveBeenCalled();
  });
});
