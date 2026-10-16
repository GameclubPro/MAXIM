import type { MaxUpdate } from '@maxim/contracts';
import {
  readExactDeleteOrigin,
  readWebhookOriginEventAt,
  withCanonicalWebhookOrigin,
} from './webhook-effect-origin-context';

function source(id = 'receipt', chatId = 'chat') {
  const update: MaxUpdate = {
    updateId: id,
    botId: 'receiving-bot',
    type: 'message_edited',
    eventTimestampSource: 'payload',
    message: {
      chatId,
      messageId: 'message',
      senderId: 'user',
      text: '',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    raw: {
      timestamp: '2026-10-16T18:00:00.000Z',
      message: { timestamp: '2026-01-01T00:00:00.000Z' },
    },
  };
  return { webhookEvent: { id, botId: 'receiving-bot' }, activeBotId: 'execution-bot', update };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('canonical webhook DELETE origin scope', () => {
  it('records event/edit time and distinct receiving/execution identities only for the exact source', async () => {
    await withCanonicalWebhookOrigin(source(), async () => {
      expect(readExactDeleteOrigin('chat', 'message')).toEqual({
        sourceWebhookEventId: 'receipt',
        sourceReceivingBotId: 'receiving-bot',
        sourceExecutionBotId: 'execution-bot',
        sourceEventAt: new Date('2026-10-16T18:00:00.000Z'),
        sourceEvidenceVersion: 1,
      });
      expect(readExactDeleteOrigin('chat', 'another-message')).toBeNull();
      expect(readExactDeleteOrigin('another-chat', 'message')).toBeNull();
      const snapshot = readExactDeleteOrigin('chat', 'message')!;
      snapshot.sourceEventAt.setTime(0);
      expect(readExactDeleteOrigin('chat', 'message')!.sourceEventAt.getUTCFullYear()).toBe(2026);
    });
    expect(readExactDeleteOrigin('chat', 'message')).toBeNull();
  });

  it.each(['missing-clock', 'ingress-clock', 'missing-bot', 'receiving-mismatch', 'other-type'])(
    'does not invent provenance for %s and still runs the handler',
    async (failure) => {
      const context = source();
      if (failure === 'missing-clock') context.update.raw = { message: { timestamp: Date.now() } };
      if (failure === 'ingress-clock') context.update.eventTimestampSource = 'ingress';
      if (failure === 'missing-bot') context.activeBotId = '';
      if (failure === 'receiving-mismatch') context.update.botId = 'other';
      if (failure === 'other-type') context.update.type = 'message_callback';
      await expect(
        withCanonicalWebhookOrigin(context, async () => {
          expect(readExactDeleteOrigin('chat', 'message')).toBeNull();
          return 'result';
        }),
      ).resolves.toBe('result');
    },
  );

  it('isolates concurrent chats and nested handlers', async () => {
    const entered = deferred(),
      release = deferred();
    const first = withCanonicalWebhookOrigin(source('one'), async () => {
      entered.resolve();
      await release.promise;
      expect(readExactDeleteOrigin('chat', 'message')?.sourceWebhookEventId).toBe('one');
      await withCanonicalWebhookOrigin(source('nested'), async () => {
        expect(readExactDeleteOrigin('chat', 'message')?.sourceWebhookEventId).toBe('nested');
      });
      expect(readExactDeleteOrigin('chat', 'message')?.sourceWebhookEventId).toBe('one');
    });
    await entered.promise;
    await withCanonicalWebhookOrigin(source('two', 'other'), async () => {
      expect(readExactDeleteOrigin('chat', 'message')).toBeNull();
      expect(readExactDeleteOrigin('other', 'message')?.sourceWebhookEventId).toBe('two');
    });
    release.resolve();
    await first;
  });

  it('keeps a timed-out handler scoped until actual settlement and invalidates later descendants', async () => {
    const handlerGate = deferred(),
      descendantGate = deferred();
    let descendant!: Promise<unknown>;
    const running = withCanonicalWebhookOrigin(source(), async () => {
      descendant = descendantGate.promise.then(() => readExactDeleteOrigin('chat', 'message'));
      await handlerGate.promise;
      expect(readExactDeleteOrigin('chat', 'message')?.sourceWebhookEventId).toBe('receipt');
    });
    expect(
      await Promise.race([running.then(() => 'finished'), Promise.resolve('guard-timeout')]),
    ).toBe('guard-timeout');
    handlerGate.resolve();
    await running;
    descendantGate.resolve();
    await expect(descendant).resolves.toBeNull();
  });

  it('preserves handler rejection and clears its context', async () => {
    const failure = new Error('handler failure');
    await expect(
      withCanonicalWebhookOrigin(source(), async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(readExactDeleteOrigin('chat', 'message')).toBeNull();
    expect(readWebhookOriginEventAt({ raw: { data: { timestamp: 1792173600 } } })).toEqual(
      new Date(1792173600000),
    );
  });
});
