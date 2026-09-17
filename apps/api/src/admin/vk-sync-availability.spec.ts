import { VkApiRequestError } from './vk-parsing-errors';
import { VkSyncService } from './vk-sync.service';

describe('VkSyncService availability confirmation', () => {
  function fixture() {
    const client = { request: jest.fn() };
    const service = new VkSyncService(
      {} as never,
      client as never,
      {} as never,
      {} as never,
      {} as never,
      { get: () => undefined } as never,
      {} as never,
    );
    return {
      client,
      internals: service as unknown as {
        spotCheckMissingPosts: (
          posts: Array<{ vkOwnerId: number; vkPostId: number }>,
        ) => Promise<Set<string> | null>;
      },
    };
  }
  const post = { vkOwnerId: -123, vkPostId: 1 };

  it.each(['vk_5', 'vk_14', 'vk_15', 'vk_100', 'http_403', 'network'])(
    'does not infer deletion from %s',
    async (code) => {
      const { client, internals } = fixture();
      client.request.mockRejectedValue(new VkApiRequestError('unavailable', code, false));
      await expect(internals.spotCheckMissingPosts([post])).resolves.toBeNull();
    },
  );

  it.each([{}, null, { items: null }, { items: [null] }, { items: [{ id: 1 }] }])(
    'does not infer deletion from malformed responses: %j',
    async (response) => {
      const { client, internals } = fixture();
      client.request.mockResolvedValue(response);
      await expect(internals.spotCheckMissingPosts([post])).resolves.toBeNull();
    },
  );

  it('splits more than 100 IDs and combines only successful confirmations', async () => {
    const { client, internals } = fixture();
    client.request.mockImplementation(async (_method, params: { posts: string }) => ({
      items: params.posts.split(',').map((key) => {
        const [owner_id, id] = key.split('_').map(Number);
        return { owner_id, id };
      }),
    }));
    const posts = Array.from({ length: 205 }, (_, i) => ({ ...post, vkPostId: i + 1 }));
    expect((await internals.spotCheckMissingPosts(posts))?.size).toBe(205);
    expect(client.request.mock.calls.map(([, params]) => params.posts.split(',').length)).toEqual([
      100, 100, 5,
    ]);
  });

  it('discards partial confirmations if a later batch fails', async () => {
    const { client, internals } = fixture();
    client.request.mockResolvedValueOnce({ items: [] }).mockRejectedValueOnce(new Error('network'));
    const posts = Array.from({ length: 101 }, (_, i) => ({ ...post, vkPostId: i + 1 }));
    await expect(internals.spotCheckMissingPosts(posts)).resolves.toBeNull();
  });

  it('accepts a well-formed empty result as confirmed absence', async () => {
    const { client, internals } = fixture();
    client.request.mockResolvedValue({ items: [] });
    await expect(internals.spotCheckMissingPosts([post])).resolves.toEqual(new Set());
  });
});
