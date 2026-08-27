import { PublicationDispatchProfile } from '../prisma/prisma-client';
import { PublisherSuggestionService } from './publisher-suggestion.service';

const user = {
  userId: 'admin-1',
  username: 'admin',
  displayName: 'Админ',
  avatarUrl: null,
  profileUrl: null,
};

function createFixture() {
  let payload: Record<string, unknown> = {
    type: 'suggest',
    text: 'Идея для поста',
    authorDisplayName: 'Читатель',
    reviewStatus: 'pending',
  };
  const row = () => ({
    id: 'suggestion-1',
    chatId: 'channel-1',
    payload,
    createdAt: new Date('2026-08-27T10:00:00.000Z'),
  });
  const auditLog = {
    findMany: jest.fn().mockImplementation(async () => [row()]),
    findFirst: jest.fn().mockImplementation(async () => row()),
    findFirstOrThrow: jest.fn().mockImplementation(async () => row()),
    findUniqueOrThrow: jest.fn().mockImplementation(async () => row()),
    updateMany: jest.fn().mockImplementation(async (args: { data: { payload: object } }) => {
      payload = args.data.payload as Record<string, unknown>;
      return { count: 1 };
    }),
  };
  const prisma = {
    auditLog,
    $transaction: jest.fn(async (callback: (tx: { auditLog: typeof auditLog }) => unknown) =>
      callback({ auditLog }),
    ),
  };
  const policy = { getEntity: jest.fn().mockResolvedValue({ id: 'channel-1' }) };
  const publications = {
    create: jest.fn().mockResolvedValue({ id: 'publication-1' }),
  };
  const service = new PublisherSuggestionService(
    prisma as never,
    policy as never,
    publications as never,
  );
  return { service, policy, publications };
}

describe('PublisherSuggestionService', () => {
  it('lists only through exact Publisher entity authorization', async () => {
    const fixture = createFixture();

    const result = await fixture.service.list('channel-1', user);

    expect(fixture.policy.getEntity).toHaveBeenCalledWith('channel', 'channel-1', user);
    expect(result.items).toEqual([
      expect.objectContaining({ id: 'suggestion-1', reviewStatus: 'pending' }),
    ]);
  });

  it('publishes an accepted suggestion only through PUBLIK_V1', async () => {
    const fixture = createFixture();

    const result = await fixture.service.review('channel-1', 'suggestion-1', user, {
      action: 'publish',
    });

    expect(fixture.publications.create).toHaveBeenCalledWith(
      user,
      expect.objectContaining({
        intent: 'publish',
        audience: expect.objectContaining({
          targets: [{ chatId: 'channel-1', entityType: 'channel' }],
        }),
      }),
      PublicationDispatchProfile.PUBLIK_V1,
    );
    expect(result.suggestion).toEqual(
      expect.objectContaining({
        reviewStatus: 'published',
        publicationId: 'publication-1',
      }),
    );
  });
});
