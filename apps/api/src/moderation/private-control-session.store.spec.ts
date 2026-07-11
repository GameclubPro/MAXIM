import { createDefaultPrivateControlSession } from './private-control-session-normalizer';
import { PrivateControlSessionStore } from './private-control-session.store';
import type { PrivateSession } from './private-control.types';

function createStore(redisCounter?: {
  getString: jest.Mock;
  setStringWithTtl: jest.Mock;
  deleteKey: jest.Mock;
  acquireLock: jest.Mock;
  releaseLock: jest.Mock;
}) {
  return new PrivateControlSessionStore({
    redisCounter: redisCounter as never,
    logger: { warn: jest.fn() },
    normalizeSession: (raw) => raw as PrivateSession,
    createDefaultSession: () => createDefaultPrivateControlSession(),
  });
}

describe('PrivateControlSessionStore', () => {
  it('isolates mutable sessions for the same user across bots', async () => {
    const store = createStore();
    const first = createDefaultPrivateControlSession();
    first.selectedChatId = 'chat-from-bot-1';
    const second = createDefaultPrivateControlSession();
    second.selectedChatId = 'chat-from-bot-2';

    await store.saveSession('user-1', first, 'bot-1');
    await store.saveSession('user-1', second, 'bot-2');

    await expect(store.loadSession('user-1', 'bot-1')).resolves.toMatchObject({
      selectedChatId: 'chat-from-bot-1',
    });
    await expect(store.loadSession('user-1', 'bot-2')).resolves.toMatchObject({
      selectedChatId: 'chat-from-bot-2',
    });
    expect(store.sessionKey('user-1', 'bot-1')).toBe('private-ui:v2:bot-1:user-1');
  });

  it('moves a legacy user-only session to exactly one bot scope', async () => {
    const store = createStore();
    const legacy = createDefaultPrivateControlSession();
    legacy.selectedChatId = 'legacy-chat';

    await store.saveSession('user-1', legacy);

    await expect(store.loadSession('user-1', 'bot-1')).resolves.toMatchObject({
      selectedChatId: 'legacy-chat',
    });
    await expect(store.loadSession('user-1', 'bot-2')).resolves.toMatchObject({
      selectedChatId: null,
    });
    await expect(store.loadSession('user-1')).resolves.toMatchObject({ selectedChatId: null });
  });

  it('moves a legacy Redis session under a migration lock and deletes the shared key', async () => {
    const values = new Map<string, string>();
    const redisCounter = {
      getString: jest.fn(async (key: string) => values.get(key) ?? null),
      setStringWithTtl: jest.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
      deleteKey: jest.fn(async (key: string) => (values.delete(key) ? 1 : 0)),
      acquireLock: jest.fn().mockResolvedValue('migration-token'),
      releaseLock: jest.fn().mockResolvedValue(undefined),
    };
    const store = createStore(redisCounter);
    const legacy = createDefaultPrivateControlSession();
    legacy.selectedChatId = 'legacy-redis-chat';

    await store.saveSession('user-2', legacy);
    await expect(store.loadSession('user-2', 'bot-1')).resolves.toMatchObject({
      selectedChatId: 'legacy-redis-chat',
    });

    expect(redisCounter.acquireLock).toHaveBeenCalledWith(
      'private-ui:v2:user-2:migration-lock',
      5_000,
    );
    expect(redisCounter.deleteKey).toHaveBeenCalledWith('private-ui:v2:user-2');
    expect(redisCounter.releaseLock).toHaveBeenCalledWith(
      'private-ui:v2:user-2:migration-lock',
      'migration-token',
    );
    expect(values.has('private-ui:v2:bot-1:user-2')).toBe(true);
    expect(values.has('private-ui:v2:user-2')).toBe(false);
  });
});
