import { randomUUID } from 'node:crypto';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { MarketplaceAccessService } from './marketplace-access.service';
import { MarketplacePublisherAccessProcessor } from './marketplace-publisher-access.processor';
import {
  MarketplacePublisherAccessQueueService,
  type MarketplacePublisherAccessJob,
} from './marketplace-publisher-access.queue';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ManagedEntitiesService } from '../../admin/managed-entities.service';
import type { MaxClientService } from '../../max/max-client.service';
import type { MarketplaceStateService } from './marketplace-state.service';
import type { PublisherIdentityAttestationService } from '../../publisher/publisher-identity-attestation.service';
import { MarketplaceRuntimeService } from './marketplace-runtime.service';
import type { MarketplaceCollectorService } from './marketplace-collector.service';
import type { MarketplaceProfileService } from './marketplace-profile.service';

jest.mock('bullmq', () => ({
  ...jest.requireActual('bullmq'),
  QueueEvents: jest.fn().mockImplementation(() => ({ close: jest.fn() })),
}));
const input = {
  actorUserId: '323459159',
  entityId: '-100',
  kind: 'CHANNEL',
  profile: 'publisher',
} as const;
describe('marketplace Publisher runtime boundary', () => {
  const oldRole = process.env.APP_ROLE,
    oldService = process.env.APP_SERVICE_NAME;
  beforeEach(() => {
    process.env.APP_ROLE = 'admin';
    process.env.APP_SERVICE_NAME = 'api-admin';
  });
  afterAll(() => {
    if (oldRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = oldRole;
    if (oldService === undefined) delete process.env.APP_SERVICE_NAME;
    else process.env.APP_SERVICE_NAME = oldService;
  });
  const fixture = () => {
    const id = randomUUID();
    const binding = {
      id,
      actor_user_id: input.actorUserId as string,
      entity_id: input.entityId,
      kind: input.kind,
      profile: input.profile,
      state: 'ACTIVE',
      valid_until: new Date(Date.now() + 60_000),
    };
    const state = { enabled: () => true, read: jest.fn().mockResolvedValue(binding) };
    const queue = { attest: jest.fn().mockResolvedValue(id) };
    const max = {
      getChatSnapshot: jest.fn(),
      getCurrentChatMemberAccess: jest.fn(),
      getChatMemberAccess: jest.fn(),
    };
    const database = { publisherEntityBinding: { findUnique: jest.fn() } };
    const identity = { assertAttested: jest.fn().mockResolvedValue(undefined) };
    const service = new MarketplaceAccessService(
      database as unknown as PrismaService,
      {} as ManagedEntitiesService,
      max as unknown as MaxClientService,
      state as unknown as MarketplaceStateService,
      queue as unknown as MarketplacePublisherAccessQueueService,
      identity as unknown as PublisherIdentityAttestationService,
    );
    return { service, state, queue, max, database, identity, binding };
  };
  it('uses the internal queue from admin without reading MAX with Major credentials', async () => {
    const f = fixture();
    expect(await f.service.attest(input)).toBe(f.binding);
    expect(f.queue.attest).toHaveBeenCalledWith(input);
    expect(f.max.getChatSnapshot).not.toHaveBeenCalled();
    expect(f.database.publisherEntityBinding.findUnique).not.toHaveBeenCalled();
  });
  it('does not report a completed connection on queue delay', async () => {
    const f = fixture();
    f.queue.attest.mockRejectedValue(new ServiceUnavailableException('Проверяем права'));
    await expect(f.service.attest(input)).rejects.toThrow(ServiceUnavailableException);
    expect(f.state.read).not.toHaveBeenCalled();
    expect(f.max.getChatSnapshot).not.toHaveBeenCalled();
  });
  it.each(['owner', 'profile', 'expiry', 'revoke'])(
    'rejects a queue result with changed %s',
    async (change) => {
      const f = fixture();
      if (change === 'owner') f.binding.actor_user_id = '999';
      if (change === 'profile') Object.assign(f.binding, { profile: 'moderation' });
      if (change === 'expiry') f.binding.valid_until = new Date(0);
      if (change === 'revoke') f.binding.state = 'REVOKED';
      await expect(f.service.attest(input)).rejects.toThrow(ServiceUnavailableException);
    },
  );
  it('does not route a non-pilot identity into Publisher work', async () => {
    const f = fixture();
    await expect(f.service.attest({ ...input, actorUserId: '999' })).rejects.toThrow(
      ForbiddenException,
    );
    expect(f.queue.attest).not.toHaveBeenCalled();
  });
  it('requires Publisher identity attestation before direct remote probes', async () => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const f = fixture();
    f.identity.assertAttested.mockRejectedValue(new Error('identity mismatch'));
    await expect(f.service.attest(input)).rejects.toThrow('identity mismatch');
    expect(f.queue.attest).not.toHaveBeenCalled();
    expect(f.max.getChatSnapshot).not.toHaveBeenCalled();
  });
  it('executes queued requests only in the Publisher role and drops expired requests', async () => {
    const access = { attest: jest.fn().mockResolvedValue({ id: randomUUID() }) };
    const processor = new MarketplacePublisherAccessProcessor(
      access as unknown as MarketplaceAccessService,
    );
    const job = {
      data: { ...input, requestedAtMs: Date.now() },
    } as Job<MarketplacePublisherAccessJob>;
    await expect(processor.process(job)).rejects.toThrow('outside Publisher');
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    expect(await processor.process(job)).toMatchObject({ state: 'ACTIVE' });
    expect(access.attest).toHaveBeenCalledWith(input);
    access.attest.mockClear();
    job.data.requestedAtMs -= 9000;
    expect(await processor.process(job)).toEqual({ state: 'RETRY' });
    expect(access.attest).not.toHaveBeenCalled();
  });
  it('does not persist MAX error details in queue results', async () => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const access = { attest: jest.fn().mockRejectedValue(new Error('raw private MAX detail')) };
    const processor = new MarketplacePublisherAccessProcessor(
      access as unknown as MarketplaceAccessService,
    );
    const job = {
      data: { ...input, requestedAtMs: Date.now() },
    } as Job<MarketplacePublisherAccessJob>;
    expect(await processor.process(job)).toEqual({ state: 'RETRY' });
    access.attest.mockRejectedValue(new ForbiddenException('private denial detail'));
    expect(await processor.process(job)).toEqual({ state: 'DENIED' });
  });
  it.each(['action', 'publisher'])('uses the matching background profile from %s', async (role) => {
    process.env.APP_ROLE = role;
    process.env.APP_SERVICE_NAME = `api-${role}`;
    const db = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    const collector = { tick: jest.fn() };
    const runtime = new MarketplaceRuntimeService(
      db as unknown as PrismaService,
      { enabled: () => true } as unknown as MarketplaceStateService,
      {} as MarketplaceAccessService,
      collector as unknown as MarketplaceCollectorService,
      {} as MarketplaceProfileService,
      {
        assertAttested: jest.fn().mockResolvedValue(undefined),
      } as unknown as PublisherIdentityAttestationService,
    );
    await runtime.tick();
    const profile = role === 'publisher' ? 'publisher' : 'moderation';
    expect(collector.tick).toHaveBeenCalledWith(profile);
    expect(db.$queryRaw.mock.calls[0]?.slice(1)).toContain(profile);
    expect(db.$queryRaw.mock.calls[1]?.slice(1)).toContain(profile);
  });
});

describe('marketplace Publisher queue replies', () => {
  const fixture = (reply: unknown) => {
    const job = { waitUntilFinished: jest.fn().mockResolvedValue(reply) };
    const queue = {
      name: 'marketplace-publisher-access',
      opts: { connection: {} },
      getJobCounts: jest.fn().mockResolvedValue({ wait: 0 }),
      add: jest.fn().mockResolvedValue(job),
    };
    return {
      service: new MarketplacePublisherAccessQueueService(queue as unknown as Queue),
      queue,
      job,
    };
  };
  it('validates completed results and bounds payload retention and wait time', async () => {
    const id = randomUUID(),
      f = fixture({ state: 'ACTIVE', bindingId: id });
    expect(await f.service.attest(input)).toBe(id);
    expect(f.queue.add).toHaveBeenCalledWith(
      'attest',
      expect.objectContaining(input),
      expect.objectContaining({ attempts: 1, removeOnComplete: { age: 30, count: 100 } }),
    );
    expect(f.job.waitUntilFinished).toHaveBeenCalledWith(expect.anything(), 8000);
    await f.service.onModuleDestroy();
  });
  it.each([{ state: 'DENIED' }, { state: 'RETRY' }, { state: 'ACTIVE', bindingId: 'malformed' }])(
    'fails closed for %j',
    async (reply) => {
      const f = fixture(reply);
      await expect(f.service.attest(input)).rejects.toThrow();
      await f.service.onModuleDestroy();
    },
  );
  it('rejects capacity exhaustion without accepting a connection', async () => {
    const f = fixture({ state: 'ACTIVE', bindingId: randomUUID() });
    f.queue.getJobCounts.mockResolvedValue({ wait: 100 });
    await expect(f.service.attest(input)).rejects.toThrow(ServiceUnavailableException);
    expect(f.queue.add).not.toHaveBeenCalled();
  });
});
