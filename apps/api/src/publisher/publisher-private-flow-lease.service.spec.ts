import { PublisherPrivateFlowType } from '../prisma/prisma-client';
import { PublisherPrivateFlowLeaseService } from './publisher-private-flow-lease.service';

describe('PublisherPrivateFlowLeaseService', () => {
  it('maps an atomically acquired lease', async () => {
    const expiresAt = new Date('2026-08-29T12:10:00.000Z');
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([
        {
          publisher_bot_id: 'publisher-bot',
          actor_user_id: '42',
          flow_type: PublisherPrivateFlowType.AUTO_REPLY_AUTHORING,
          flow_id: 'session-1',
          lease_token: 'lease-1',
          expires_at: expiresAt,
        },
      ]),
    };
    const service = new PublisherPrivateFlowLeaseService(prisma as never);

    await expect(
      service.acquire({
        publisherBotId: 'publisher-bot',
        actorUserId: '42',
        flowType: PublisherPrivateFlowType.AUTO_REPLY_AUTHORING,
        flowId: 'session-1',
        leaseToken: 'lease-1',
        expiresAt,
      }),
    ).resolves.toEqual({
      publisherBotId: 'publisher-bot',
      actorUserId: '42',
      flowType: PublisherPrivateFlowType.AUTO_REPLY_AUTHORING,
      flowId: 'session-1',
      leaseToken: 'lease-1',
      expiresAt,
    });
  });

  it('returns null when another live private flow owns the actor', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };
    const service = new PublisherPrivateFlowLeaseService(prisma as never);

    await expect(
      service.acquire({
        publisherBotId: 'publisher-bot',
        actorUserId: '42',
        flowType: PublisherPrivateFlowType.AUTO_REPLY_AUTHORING,
        flowId: 'session-1',
        leaseToken: 'lease-1',
        expiresAt: new Date('2026-08-29T12:10:00.000Z'),
      }),
    ).resolves.toBeNull();
  });

  it('never shortens the expiry when the same flow is acquired from a stale replay', async () => {
    let queryText = '';
    const prisma = {
      $queryRaw: jest.fn().mockImplementation(async (value: { strings?: readonly string[] }) => {
        queryText = value.strings?.join(' ') ?? '';
        return [];
      }),
    };
    const service = new PublisherPrivateFlowLeaseService(prisma as never);

    await service.acquire({
      publisherBotId: 'publisher-bot',
      actorUserId: '42',
      flowType: PublisherPrivateFlowType.AUTO_REPLY_AUTHORING,
      flowId: 'session-1',
      leaseToken: 'session-1',
      expiresAt: new Date('2026-08-29T12:10:00.000Z'),
    });

    expect(queryText).toContain('GREATEST');
  });

  it('renews the exact lease monotonically', async () => {
    let queryText = '';
    const service = new PublisherPrivateFlowLeaseService({
      $executeRaw: jest.fn().mockImplementation(async (value: { strings?: readonly string[] }) => {
        queryText = value.strings?.join(' ') ?? '';
        return 1;
      }),
    } as never);

    await expect(
      service.renew({
        publisherBotId: 'publisher-bot',
        actorUserId: '42',
        flowType: PublisherPrivateFlowType.AUTO_REPLY_AUTHORING,
        flowId: 'session-1',
        leaseToken: 'session-1',
        expiresAt: new Date('2026-08-29T12:10:00.000Z'),
      }),
    ).resolves.toBe(true);
    expect(queryText).toContain('GREATEST');
  });

  it('releases only the exact flow owner and lease token', async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
    const service = new PublisherPrivateFlowLeaseService({
      publisherPrivateFlowLease: { deleteMany },
    } as never);

    await expect(
      service.release({
        publisherBotId: 'publisher-bot',
        actorUserId: '42',
        flowType: PublisherPrivateFlowType.POST_IMPORT,
        flowId: 'post-import-1',
        leaseToken: 'lease-1',
      }),
    ).resolves.toBe(true);
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        publisherBotId: 'publisher-bot',
        actorUserId: '42',
        flowType: PublisherPrivateFlowType.POST_IMPORT,
        flowId: 'post-import-1',
        leaseToken: 'lease-1',
      },
    });
  });
});
