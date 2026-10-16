import { ChannelAutoPostScanManager } from './channel-auto-post-runtime';

type ScanParams = Parameters<ChannelAutoPostScanManager['processListedMessages']>[0];
type Attach = ScanParams['attach'];

function fixture() {
  let now = 10_000;
  const manager = new ChannelAutoPostScanManager({
    scanIntervalMs: 1_000,
    scanMaxChannels: 8,
    idleBackoffMaxMs: 8_000,
    repairSweepMs: 5_000,
    rateLimitBackoffMs: 100,
    throttleBackoffMaxMs: 500,
    now: () => now,
  });
  const scan = (messages: ScanParams['messages'], attach: Attach, limit = 1) =>
    manager.processListedMessages({
      chatId: 'channel',
      messages,
      attach,
      maxNewMessagesPerScan: limit,
      settingsUpdatedAtMs: 0,
      adminUserIds: [],
    });
  return {
    manager,
    scan,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

const post = (id: string, timestamp: number) => ({ id, timestamp, body: { text: 'Post' } });

describe('channel polling fairness without completion or effect authority', () => {
  it('visits continuously due channels while other channels enter and leave cooldown', () => {
    const { manager, tick } = fixture();
    const channels = ['a', 'b', 'c', 'd', 'e', 'f'].map((chatId) => ({ chatId }));
    const visited: string[][] = [];
    for (let round = 0; round < 12; round += 1) {
      const batch = manager.selectBatch(round % 2 ? [...channels].reverse() : channels, 2);
      visited.push(batch.map((channel) => channel.chatId));
      expect(batch).toHaveLength(2);
      for (const channel of batch) manager.recordTransientThrottle(channel.chatId, true, 60_000);
      tick(30_000);
    }
    expect(visited.slice(0, 3)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
    for (const channel of channels) {
      expect(visited.flat().filter((id) => id === channel.chatId)).toHaveLength(4);
    }
    expect(manager.resolveBatchSize()).toBe(8);
  });

  it('keeps the channel position when the last selected identity disappears', () => {
    const { manager } = fixture();
    const refs = (...ids: string[]) => ids.map((chatId) => ({ chatId }));
    expect(manager.selectBatch(refs('c', 'a', 'e'), 1)).toEqual(refs('a'));
    expect(manager.selectBatch(refs('f', 'e', 'b', 'c'), 1)).toEqual(refs('b'));
    expect(manager.selectBatch([], 1)).toEqual([]);
    expect(manager.selectBatch(refs('e', 'a', 'c'), 1)).toEqual(refs('c'));
    expect(manager.selectBatch(refs('a', 'b'), 1)).toEqual(refs('a'));
  });

  it.each([1, 2])(
    'reaches later posts with attempt budget %i while preserving unresolved positions',
    async (limit) => {
      const { manager, scan } = fixture();
      const messages = [post('a', 100), post('b', 100), post('c', 101), post('d', 102)];
      const attach = jest.fn<ReturnType<Attach>, Parameters<Attach>>(async ({ messageId }) =>
        messageId === 'a' || messageId === 'b' ? 'in_progress' : 'attached',
      );
      for (let round = 0; round < 4; round += 1) {
        const before = attach.mock.calls.length;
        await scan([...messages].reverse(), attach, limit);
        expect(attach.mock.calls.length - before).toBeLessThanOrEqual(limit);
      }
      expect(new Set(attach.mock.calls.map(([message]) => message.messageId))).toEqual(
        new Set(['a', 'b', 'c', 'd']),
      );
      expect(manager.states.get('channel')?.latestTimestampMs).toBe(0);
      expect(attach.mock.calls.filter(([message]) => message.messageId === 'c')).toHaveLength(1);
      attach.mockResolvedValue('attached');
      await scan(messages, attach, 2);
      expect(manager.states.get('channel')).toMatchObject({
        latestTimestampMs: 102,
        latestMessageIdsAtTimestamp: ['d'],
      });
    },
  );

  it('retains an unknown post that disappeared from the latest page until its own terminal result', async () => {
    const { manager, scan } = fixture();
    await scan([post('blocked', 100)], async () => 'in_progress');
    await scan([post('new', 200)], async () => 'attached');
    expect(manager.states.get('channel')?.latestTimestampMs).toBe(0);
    await scan([post('blocked', 100)], async () => 'noop');
    expect(manager.states.get('channel')?.latestTimestampMs).toBe(200);
  });

  it('retains an unvisited post that falls out of the page when the per-scan budget is exhausted', async () => {
    const { manager, scan } = fixture();
    await scan([post('first', 100), post('unvisited', 200)], async () => 'attached');
    await scan([post('later', 300)], async () => 'attached');
    expect(manager.states.get('channel')?.latestTimestampMs).toBe(100);
    await scan([post('unvisited', 200)], async () => 'skipped');
    expect(manager.states.get('channel')?.latestTimestampMs).toBe(300);
  });

  it('propagates failures to cooldown, preserves the completed prefix and rotates on the next scan', async () => {
    const { manager, scan } = fixture();
    const messages = [post('first', 100), post('fails', 200), post('later', 300)];
    const error = new Error('GET throttled');
    const attach = jest.fn<ReturnType<Attach>, Parameters<Attach>>(async ({ messageId }) => {
      if (messageId === 'fails') throw error;
      return 'attached';
    });
    await expect(scan(messages, attach, 3)).rejects.toBe(error);
    expect(attach).toHaveBeenCalledTimes(2);
    expect(manager.states.get('channel')?.latestTimestampMs).toBe(100);
    await scan(messages, attach);
    expect(attach.mock.calls.at(-1)?.[0].messageId).toBe('later');
    expect(manager.states.get('channel')?.latestTimestampMs).toBe(100);
  });

  it('does not treat an unknown callback result as completion', async () => {
    const { manager, scan } = fixture();
    await scan(
      [post('unknown', 100)],
      async () => undefined as unknown as Awaited<ReturnType<Attach>>,
    );
    await scan([post('later', 200)], async () => 'attached');
    expect(manager.states.get('channel')?.latestTimestampMs).toBe(0);
  });

  it('does not erase unresolved work when settings move forward', async () => {
    const { manager, scan } = fixture();
    await scan([post('blocked', 100)], async () => 'in_progress');
    const attach = jest.fn<ReturnType<Attach>, Parameters<Attach>>(async () => 'attached');
    await manager.processListedMessages({
      chatId: 'channel',
      messages: [post('blocked', 100), post('later', 300)],
      attach,
      settingsUpdatedAtMs: 200,
      adminUserIds: [],
      maxNewMessagesPerScan: 2,
    });
    expect(attach.mock.calls.map(([message]) => message.messageId)).toEqual(['later']);
    expect(manager.states.get('channel')?.latestTimestampMs).toBe(0);
  });

  it('caps retained positions and keeps independent attempts possible after overflow', async () => {
    const { manager, scan } = fixture();
    const page = (offset: number) =>
      Array.from({ length: 10 }, (_, i) => post(`post-${offset + i}`, offset + i + 100));
    for (const offset of [0, 10, 20, 30]) await scan(page(offset), async () => 'in_progress', 10);
    for (const offset of [0, 10, 20, 30]) await scan(page(offset), async () => 'attached', 10);
    const attach = jest.fn<ReturnType<Attach>, Parameters<Attach>>(async () => 'attached');
    await scan(page(40), attach, 2);
    expect(attach).toHaveBeenCalledTimes(2);
    expect(manager.states.get('channel')?.latestTimestampMs).toBe(131);
  });
});
