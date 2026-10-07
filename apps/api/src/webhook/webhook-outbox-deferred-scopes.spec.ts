import { DeferredWebhookScopes, DEFERRED_SCOPE_LIMIT } from './webhook-outbox-deferred-scopes';

const a = { botId: 'a', workClass: 'ordinary' as const };
const b = { botId: 'b', workClass: 'ordinary' as const };
const cursor = (index: number) => ({
  id: `receipt-${index.toString().padStart(5, '0')}`,
  createdAt: new Date(index),
});

describe('bounded deferred outbox scope responsibility', () => {
  it('covers overflow with a fixed current interval and next interval without cursor rewind', () => {
    const scopes = new DeferredWebhookScopes();
    scopes.capture(a, 'first', cursor(10));
    const [state] = scopes.selectReaders(2);
    scopes.advance(state!, cursor(10), false);
    for (let index = 0; index < 1000; index++)
      scopes.capture(a, `overflow-${index}`, cursor(index));
    expect(state!.current).toEqual({ first: cursor(10), last: cursor(10) });
    expect(state!.after).toEqual(cursor(10));
    expect(state!.next).toEqual({ first: cursor(0), last: cursor(999) });
    scopes.advance(state!, cursor(10), true);
    expect(state!.current).toEqual({ first: cursor(0), last: cursor(999) });
    expect(state!.after).toBeNull();
    scopes.advance(state!, cursor(200), false);
    for (let index = 0; index < 100; index++) scopes.capture(a, 'hot-retry', cursor(0));
    expect(state!.after).toEqual(cursor(200));
    expect(state!.next).toEqual({ first: cursor(0), last: cursor(0) });
  });

  it('keeps a saturated scope separate from independent discovery and bounds identities', () => {
    const scopes = new DeferredWebhookScopes();
    scopes.capture(a, 'a-1', cursor(1));
    const [first] = scopes.selectReaders(2);
    expect(scopes.retain(first!, 'a-1', cursor(1))).toBe(true);
    expect(scopes.retain(first!, 'a-2', cursor(2))).toBe(true);
    expect(scopes.retain(first!, 'a-3', cursor(3))).toBe(false);
    scopes.capture(a, 'a-3', cursor(3));
    scopes.capture(b, 'b-1', cursor(4));
    const readers = scopes.selectReaders(2);
    expect(readers.map(({ scope }) => scope?.botId)).toEqual(['b']);
    scopes.retain(readers[0]!, 'b-1', cursor(4));
    expect(scopes.identities(2).map(({ id }) => id)).toEqual([cursor(1).id, cursor(4).id]);
    scopes.release('a-1', cursor(1).id);
    expect(scopes.selectReaders(2)).toContain(first);
    expect(first!.next).toEqual({ first: cursor(3), last: cursor(3) });
  });

  it('covers arbitrary identity cardinality in one bounded overflow scope', () => {
    const scopes = new DeferredWebhookScopes();
    for (let index = 0; index < 1000; index++)
      scopes.capture({ ...a, botId: `bot-${index}` }, `unit-${index}`, cursor(index));
    expect(scopes.snapshot()).toEqual({
      scopes: DEFERRED_SCOPE_LIMIT + 1,
      identities: 0,
      intervals: DEFERRED_SCOPE_LIMIT + 2,
    });
    const visited = new Set<string>();
    for (let pass = 0; pass < 100; pass++)
      for (const state of scopes.selectReaders(2)) {
        visited.add(state.key);
        scopes.retain(state, `first-${state.key}`, cursor(1));
        scopes.retain(state, `second-${state.key}`, cursor(2));
      }
    expect(visited.size).toBe(DEFERRED_SCOPE_LIMIT + 1);
    expect(scopes.snapshot().identities).toBe(2 * (DEFERRED_SCOPE_LIMIT + 1));
    expect(scopes.selectReaders(2)).toEqual([]);
  });

  it('retains a changed exact head in the next interval while the old identity is pending', () => {
    const scopes = new DeferredWebhookScopes();
    scopes.capture(a, 'same-chat', cursor(1));
    const [state] = scopes.selectReaders(1);
    scopes.retain(state!, 'same-chat', cursor(1));
    scopes.capture(a, 'same-chat', cursor(2));
    expect(state!.next).toEqual({ first: cursor(2), last: cursor(2) });
    scopes.release('same-chat', cursor(1).id);
    scopes.advance(state!, cursor(1), true);
    expect(state!.current).toEqual({ first: cursor(2), last: cursor(2) });
  });

  it('coalesces same-chat rows without dropping a follower before the retained head admits', () => {
    const scopes = new DeferredWebhookScopes();
    scopes.capture(a, 'chat', cursor(1));
    const [state] = scopes.selectReaders(1);
    scopes.retain(state!, 'chat', cursor(1));
    expect(scopes.retain(state!, 'chat', cursor(2))).toBe(true);
    expect(state!.retained.get('chat')).toEqual(cursor(1));
    expect(state!.next).toEqual({ first: cursor(2), last: cursor(2) });
    scopes.release('chat', cursor(1).id);
    scopes.advance(state!, cursor(2), true);
    expect(state!.current).toEqual({ first: cursor(2), last: cursor(2) });
  });

  it('releases only the exact receipt when one chat is retained across different scopes', () => {
    const scopes = new DeferredWebhookScopes();
    scopes.capture(a, 'chat', cursor(1));
    scopes.capture(b, 'chat', cursor(2));
    for (const state of scopes.selectReaders(2)) {
      const receipt = state.scope?.botId === 'a' ? cursor(1) : cursor(2);
      scopes.retain(state, 'chat', receipt);
      scopes.advance(state, receipt, true);
    }
    expect(scopes.snapshot()).toEqual({ scopes: 2, identities: 2, intervals: 0 });
    scopes.release('chat', cursor(1).id);
    expect(scopes.identities(10).map(({ id }) => id)).toEqual([cursor(2).id]);
  });
});
