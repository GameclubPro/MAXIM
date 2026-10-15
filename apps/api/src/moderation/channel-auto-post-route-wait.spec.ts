import { MaxApiInternalRateLimitError } from '../max/max-client.service';
import {
  ChannelAutoPostMutationGuard,
  readChannelRouteReadWait,
  resolveInitialChannelMutationRoute,
} from './channel-auto-post-mutation-guard';
import { ReplacementAttachMarkerStore } from './replacement-attach-marker.store';

function guardFor(read: jest.Mock, candidates = ['bot-a']) {
  return new ChannelAutoPostMutationGuard({
    maxClient: { getCurrentChatMemberAccess: read, getChatSnapshot: jest.fn() },
    resolveActionCandidateBotIds: async () => candidates,
    resolveExecutableBotIdentity: (id: string) => ({ id }),
    isCurrentChannelEntity: async () => true,
  } as never);
}

it('keeps an exact initial-read nomination separate from another chat and final authorization', async () => {
  const error = new MaxApiInternalRateLimitError('Fixture read quota', 250);
  const guard = guardFor(jest.fn().mockRejectedValue(error));
  await expect(
    guard.resolveMutationBotRoute({ chatId: '-1', action: 'edit_message' }),
  ).rejects.toBe(error);
  expect(readChannelRouteReadWait(error, '-1')).toEqual({ chatId: '-1', botId: 'bot-a' });
  expect(readChannelRouteReadWait(error, '-2')).toBeNull();
  const finalError = new MaxApiInternalRateLimitError('Fixture final quota', 250);
  const finalRead = jest.fn().mockRejectedValue(finalError);
  const finalGuard = guardFor(finalRead);
  // The target GET itself may fail before the final member read; neither is the initial route.
  (finalGuard as any).dependencies.maxClient.getChatSnapshot.mockResolvedValue({
    entityType: 'channel',
  });
  await expect(finalGuard.assertEditAuthorized('-1', 'bot-a')).rejects.toBe(finalError);
  expect(readChannelRouteReadWait(finalError, '-1')).toBeNull();
});

it('does not nominate a forward-replacement delete route', async () => {
  const error = new MaxApiInternalRateLimitError('Fixture read quota', 250);
  const guard = guardFor(jest.fn().mockRejectedValue(error));
  await expect(
    guard.resolveMutationBotRoute({ chatId: '-1', action: 'delete_message' }),
  ).rejects.toBe(error);
  expect(readChannelRouteReadWait(error, '-1')).toBeNull();
});

it('still selects a later candidate with freshly proven edit access', async () => {
  const error = new MaxApiInternalRateLimitError('Fixture read quota', 250);
  const read = jest
    .fn()
    .mockRejectedValueOnce(error)
    .mockResolvedValue({ isAdmin: true, isOwner: false, permissions: ['edit_message'] });
  const guard = guardFor(read, ['bot-a', 'bot-b']);
  await expect(
    guard.resolveMutationBotRoute({ chatId: '-1', action: 'edit_message' }),
  ).resolves.toEqual({ botId: 'bot-b', requiredAuthorVerified: true });
  expect(read).toHaveBeenCalledTimes(2);
});

it('keeps the original unknown failure when a later candidate encounters a quota refusal', async () => {
  const unknown = new Error('Fixture unknown access');
  const local = new MaxApiInternalRateLimitError('Fixture read quota', 250);
  const guard = guardFor(jest.fn().mockRejectedValueOnce(unknown).mockRejectedValueOnce(local), [
    'bot-a',
    'bot-b',
  ]);
  await expect(
    guard.resolveMutationBotRoute({ chatId: '-1', action: 'edit_message' }),
  ).rejects.toBe(unknown);
  expect(readChannelRouteReadWait(unknown, '-1')).toBeNull();
});

it.each([
  { chatId: '-2' },
  { botId: 'bot-b' },
  { source: 'poll' },
  { linkType: 'forward' },
  { quickButtons: { buttons: [] } },
])('does not persist a route wait outside its supported exact edit: %j', async (override) => {
  const error = new MaxApiInternalRateLimitError('Fixture read quota', 250);
  const guard = guardFor(jest.fn().mockRejectedValue(error));
  await expect(
    guard.resolveMutationBotRoute({ chatId: '-1', action: 'edit_message' }),
  ).rejects.toBe(error);
  const updateMany = jest.fn();
  const store = new ReplacementAttachMarkerStore({
    channelAutoPostAttachMarker: { updateMany },
  } as never);
  const input = {
    chatId: '-1',
    messageId: 'm',
    botId: 'bot-a',
    lockToken: 'lease',
    source: 'webhook' as const,
    linkType: null,
    ...override,
  };
  expect(
    await store.deferChannelRouteBeforeDispatch(
      input as Parameters<typeof store.deferChannelRouteBeforeDispatch>[0],
      error,
    ),
  ).toBe(false);
  expect(updateMany).not.toHaveBeenCalled();
  if (!('botId' in override)) {
    await expect(
      resolveInitialChannelMutationRoute(
        async () => {
          throw error;
        },
        input as Parameters<typeof resolveInitialChannelMutationRoute>[1],
      ),
    ).rejects.toBe(error);
  }
});
