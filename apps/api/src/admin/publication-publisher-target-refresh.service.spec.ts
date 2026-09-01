import { NotFoundException } from '@nestjs/common';
import { PublicationDispatchProfile } from '../prisma/prisma-client';
import { PublicationPublisherTargetRefreshService } from './publication-publisher-target-refresh.service';

describe('PublicationPublisherTargetRefreshService', () => {
  const user = { userId: 'actor-1', username: null, displayName: null };

  it('refreshes the exact frozen targets of the actor-owned Publik publication', async () => {
    const targets = Array.from({ length: 500 }, (_, index) => ({
      targetChatId: `target-${index}`,
    }));
    const findFirst = jest.fn().mockResolvedValue({ targets });
    const requestAuthorizedEntitiesRefresh = jest
      .fn()
      .mockResolvedValue({ accepted: true, queuedCount: 500 });
    const service = new PublicationPublisherTargetRefreshService(
      { publication: { findFirst } } as never,
      { requestAuthorizedEntitiesRefresh } as never,
    );

    await expect(service.request('publication-1', user)).resolves.toEqual({
      accepted: true,
      queuedCount: 500,
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: 'publication-1',
        actorUserId: 'actor-1',
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      },
      select: {
        targets: {
          orderBy: { position: 'asc' },
          select: { targetChatId: true },
        },
      },
    });
    expect(requestAuthorizedEntitiesRefresh).toHaveBeenCalledWith(
      targets.map((target) => target.targetChatId),
      user,
    );
  });

  it('returns not found without enqueueing for another actor or dispatch profile', async () => {
    const requestAuthorizedEntitiesRefresh = jest.fn();
    const service = new PublicationPublisherTargetRefreshService(
      { publication: { findFirst: jest.fn().mockResolvedValue(null) } } as never,
      { requestAuthorizedEntitiesRefresh } as never,
    );

    await expect(service.request('foreign-publication', user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(requestAuthorizedEntitiesRefresh).not.toHaveBeenCalled();
  });
});
