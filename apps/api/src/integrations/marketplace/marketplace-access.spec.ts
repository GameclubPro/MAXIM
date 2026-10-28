import { ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { MarketplaceAccessService } from './marketplace-access.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ManagedEntitiesService } from '../../admin/managed-entities.service';
import type { MaxClientService } from '../../max/max-client.service';
import type { MarketplaceStateService } from './marketplace-state.service';
import type { PublisherIdentityAttestationService } from '../../publisher/publisher-identity-attestation.service';
import type { BackgroundRuntimeGovernorService } from '../../system/background-runtime-governor.service';

describe('marketplace fresh access checks', () => {
  const previousRole = process.env.APP_ROLE;
  const previousService = process.env.APP_SERVICE_NAME;
  beforeEach(() => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
  });
  afterAll(() => {
    if (previousRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = previousRole;
    if (previousService === undefined) delete process.env.APP_SERVICE_NAME;
    else process.env.APP_SERVICE_NAME = previousService;
  });
  const input = {
    actorUserId: '323459159',
    entityId: '-100',
    kind: 'CHANNEL',
    profile: 'publisher',
  };
  const make = () => {
    const database = {
      publisherEntityBinding: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ publisherBotId: 'publisher-test', status: 'ACTIVE' }),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
      $transaction: jest.fn(),
    };
    const connection = {
      publisherBotId: 'publisher-test',
      botId: 'major-test',
      status: 'ACTIVE',
      lifecycleEventAt: null,
      botAccessCheckedAt: null,
      botAccessState: 'UNKNOWN',
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'test-binding' }]),
      chatMembershipActivityEvent: { findFirst: jest.fn().mockResolvedValue(null) },
      managedEntityAccessEdge: { findFirst: jest.fn().mockResolvedValue(null) },
      publisherEntityBinding: { findUnique: jest.fn().mockResolvedValue(connection) },
      chatBotMembership: { findUnique: jest.fn().mockResolvedValue(connection) },
    };
    database.$transaction.mockImplementation(async (callback) => callback(tx));
    const entities = {
      assertManagedEntityAdminAccess: jest.fn(),
      resolveManagedEntityReadBotId: jest.fn().mockResolvedValue('major-test'),
    };
    const max = {
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: '-100',
        entityType: 'channel',
        title: 'Test',
        isPublic: true,
        link: null,
        avatarUrl: null,
        participantsCount: 1,
      }),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'publisher-test',
        isBot: true,
        isAdmin: true,
        isOwner: false,
      }),
      getChatMemberAccess: jest
        .fn()
        .mockResolvedValue({ userId: '323459159', isBot: false, isAdmin: true, isOwner: false }),
    };
    const state = { enabled: () => true };
    const governor = {
      decide: jest
        .fn<
          ReturnType<BackgroundRuntimeGovernorService['decide']>,
          Parameters<BackgroundRuntimeGovernorService['decide']>
        >()
        .mockResolvedValue({ action: 'run', retryAfterMs: 0, reason: 'healthy' }),
    } satisfies Pick<BackgroundRuntimeGovernorService, 'decide'>;
    return {
      governor,
      database,
      entities,
      max,
      tx,
      service: new MarketplaceAccessService(
        database as unknown as PrismaService,
        entities as unknown as ManagedEntitiesService,
        max as unknown as MaxClientService,
        state as MarketplaceStateService,
        undefined,
        {
          assertAttested: jest.fn().mockResolvedValue(undefined),
        } as unknown as PublisherIdentityAttestationService,
        undefined,
        governor,
      ),
    };
  };
  it('admits a non-pilot administrator only after exact remote rights checks', async () => {
    const { service, max } = make();
    max.getChatMemberAccess.mockResolvedValue({
      userId: '999',
      isBot: false,
      isAdmin: true,
      isOwner: false,
    });
    await expect(service.attest({ ...input, actorUserId: '999' })).resolves.toEqual({
      id: 'test-binding',
    });
    expect(max.getChatMemberAccess).toHaveBeenCalledWith(
      '-100',
      '999',
      expect.objectContaining({ botId: 'publisher-test', bypassCache: true }),
    );
  });
  it('does not treat a cached Publisher edge as fresh admin authority', async () => {
    const { service, max, database } = make();
    max.getChatMemberAccess.mockResolvedValue({
      userId: '323459159',
      isBot: false,
      isAdmin: false,
      isOwner: false,
    });
    await expect(service.attest(input)).rejects.toThrow(ForbiddenException);
    expect(max.getChatMemberAccess).toHaveBeenCalledWith(
      '-100',
      '323459159',
      expect.objectContaining({ botId: 'publisher-test', bypassCache: true }),
    );
    expect(database.$transaction).not.toHaveBeenCalled();
  });
  it('keeps unknown member access distinct from confirmed revocation', async () => {
    const { service, max, database } = make();
    max.getChatMemberAccess.mockResolvedValue(null);
    await expect(service.attest(input)).rejects.toThrow(ServiceUnavailableException);
    expect(database.$executeRaw).not.toHaveBeenCalled();
  });
  it('rejects an actor proof for another user', async () => {
    const { service, max } = make();
    max.getChatMemberAccess.mockResolvedValue({
      userId: '999',
      isBot: false,
      isAdmin: true,
      isOwner: false,
    });
    await expect(service.attest(input)).rejects.toThrow(ForbiddenException);
  });
  it('fences Publisher reassignment while remote probes are in flight', async () => {
    const { service, tx } = make();
    tx.publisherEntityBinding.findUnique.mockResolvedValue({
      publisherBotId: 'another-bot',
      status: 'ACTIVE',
    });
    await expect(service.attest(input)).rejects.toThrow(ConflictException);
  });
  it('fences a later bot removal before granting access', async () => {
    const { service, tx } = make();
    tx.publisherEntityBinding.findUnique.mockResolvedValue({
      publisherBotId: 'publisher-test',
      status: 'ACTIVE',
      lifecycleEventAt: new Date(Date.now() + 1000),
    });
    await expect(service.attest(input)).rejects.toThrow(ConflictException);
  });
  it('fences a newer exact-bot user denial received during the remote probe', async () => {
    const { service, tx } = make();
    tx.managedEntityAccessEdge.findFirst.mockResolvedValue({ chatId: '-100' });
    await expect(service.attest(input)).rejects.toThrow(ConflictException);
    expect(tx.managedEntityAccessEdge.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: '-100',
          userId: '323459159',
          botId: 'publisher-test',
          checkedAt: { gte: expect.any(Date) },
        }),
      }),
    );
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });
  it('Major uses the strict entity facade before reading exact membership', async () => {
    const { service, entities, max } = make();
    entities.assertManagedEntityAdminAccess.mockRejectedValue(new ForbiddenException());
    await expect(service.attest({ ...input, profile: 'moderation' })).rejects.toThrow(
      ForbiddenException,
    );
    expect(entities.assertManagedEntityAdminAccess).toHaveBeenCalledWith(
      '-100',
      expect.objectContaining({ userId: '323459159' }),
      'channel',
    );
    expect(max.getChatSnapshot).not.toHaveBeenCalled();
  });
  it('defers background rights before SQL or MAX without changing access evidence', async () => {
    const { service, governor, database, max } = make();
    governor.decide.mockResolvedValue({ action: 'pause', retryAfterMs: 60_000, reason: 'max_api' });
    await expect(service.attest(input, false, true)).rejects.toThrow(ServiceUnavailableException);
    expect(database.publisherEntityBinding.findUnique).not.toHaveBeenCalled();
    expect(database.$transaction).not.toHaveBeenCalled();
    expect(database.$executeRaw).not.toHaveBeenCalled();
    expect(max.getChatSnapshot).not.toHaveBeenCalled();
    governor.decide.mockResolvedValue({ action: 'run', retryAfterMs: 0, reason: 'healthy' });
    await expect(service.attest(input, false, true)).rejects.toThrow(ServiceUnavailableException);
    expect(governor.decide).toHaveBeenCalledTimes(1);
    await service.attest(input);
    expect(max.getChatSnapshot).toHaveBeenCalledWith(
      '-100',
      expect.objectContaining({ trafficClass: 'interactive' }),
    );
  });
  it('uses background quota while preserving every fresh rights probe and final binding check', async () => {
    const { service, max, database } = make();
    await service.attest(input, false, true);
    const options = expect.objectContaining({
      bypassCache: true,
      trafficClass: 'background',
      sourceTag: 'marketplace_access_refresh',
    });
    expect(max.getChatSnapshot).toHaveBeenCalledWith('-100', options);
    expect(max.getCurrentChatMemberAccess).toHaveBeenCalledWith('-100', options);
    expect(max.getChatMemberAccess).toHaveBeenCalledWith('-100', '323459159', options);
    expect(database.$transaction).toHaveBeenCalledTimes(1);
  });
  it('admits only one background operation and drains it on shutdown without queued followups', async () => {
    const { service, governor, max } = make();
    let release!: (value: Awaited<ReturnType<BackgroundRuntimeGovernorService['decide']>>) => void;
    governor.decide.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = service.attest(input, false, true).catch((error: unknown) => error);
    await expect(service.attest(input, false, true)).rejects.toThrow(ServiceUnavailableException);
    let drained = false;
    const closing = service.onModuleDestroy().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release({ action: 'run', retryAfterMs: 0, reason: 'healthy' });
    expect(await first).toBeInstanceOf(ServiceUnavailableException);
    await closing;
    expect(max.getChatSnapshot).not.toHaveBeenCalled();
    await expect(service.attest(input, false, true)).rejects.toThrow(ServiceUnavailableException);
  });
  it('admits one slow check and preserves the governor cooldown before the next check', async () => {
    const { service, governor, max } = make();
    const clock = jest.spyOn(Date, 'now');
    let now = Date.now();
    clock.mockImplementation(() => now);
    try {
      governor.decide.mockResolvedValue({
        action: 'slow',
        retryAfterMs: 60_000,
        reason: 'pressure',
      });
      await service.attest(input, false, true);
      await expect(service.attest(input, false, true)).rejects.toThrow(ServiceUnavailableException);
      expect(max.getChatSnapshot).toHaveBeenCalledTimes(1);
      now += 60_001;
      await service.attest(input, false, true);
      expect(max.getChatSnapshot).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });
  it('retains background admission until sibling reads settle after an early failure', async () => {
    const { service, max, database } = make();
    let release!: (value: null) => void;
    const pendingRead = new Promise<null>((resolve) => {
      release = resolve;
    });
    max.getChatSnapshot.mockRejectedValue(new Error('synthetic unavailable'));
    max.getChatMemberAccess.mockReturnValue(pendingRead);
    const first = service.attest(input, false, true).catch((error: unknown) => error);
    for (let turn = 0; turn < 10 && !max.getChatSnapshot.mock.calls.length; turn++)
      await Promise.resolve();
    expect(max.getChatSnapshot).toHaveBeenCalledTimes(1);
    await expect(service.attest(input, false, true)).rejects.toThrow(ServiceUnavailableException);
    let drained = false;
    const closing = service.onModuleDestroy().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release(null);
    expect(await first).toEqual(new Error('synthetic unavailable'));
    await closing;
    expect(database.$transaction).not.toHaveBeenCalled();
    expect(database.$executeRaw).not.toHaveBeenCalled();
  });
});
