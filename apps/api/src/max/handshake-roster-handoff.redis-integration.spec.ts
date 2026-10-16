import { Queue, Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { handOffHandshakeRoster } from './handshake-roster-handoff';
import type { MaxChatAdminRosterSyncJob } from './max-chat-admin-roster-sync.queue';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL ?? '';
const integration = redisUrl ? describe : describe.skip;

integration('Explicit Start roster handoff on Redis', () => {
  it('retains fresh work behind an active probe across producer restart, independently per bot', async () => {
    const url = new URL(redisUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Local Redis required');
    const name = 'handshake-roster';
    const options = {
      prefix: `test-${randomUUID()}`,
      connection: { host: url.hostname, port: Number(url.port) },
    };
    let queue = new Queue<MaxChatAdminRosterSyncJob>(name, options);
    const worker = new Worker<MaxChatAdminRosterSyncJob>(name, async () => undefined, {
      ...options,
      autorun: false,
    });
    const job = (botId: string, title: string): MaxChatAdminRosterSyncJob => ({
      chatId: '-100',
      botIds: [botId],
      entityType: 'chat',
      source: 'handshake_start',
      title,
    });
    const policy = { attempts: 3, priority: 2, backoff: { type: 'exponential', delay: 2000 } };
    try {
      await handOffHandshakeRoster(queue, job('bot-1', 'Before Start'), policy);
      const active = (await worker.getNextJob('old-probe'))!;
      expect(active.data.title).toBe('Before Start');
      for (let i = 0; i < 8; i++)
        await handOffHandshakeRoster(queue, job('bot-1', `Fresh ${i}`), policy);
      await handOffHandshakeRoster(queue, job('bot-2', 'Second bot'), policy);
      for (let i = 0; i < 8; i++)
        await handOffHandshakeRoster(queue, job('bot-2', 'Second bot'), policy);

      await queue.close();
      queue = new Queue<MaxChatAdminRosterSyncJob>(name, options);
      await active.moveToCompleted(undefined, 'old-probe', false);
      const completed: Array<{ botId: string; title: string | null | undefined }> = [];
      for (let i = 0; i < 2; i++) {
        const next = (await worker.getNextJob(`fresh-${i}`))!;
        expect(next).toBeDefined();
        completed.push({ botId: next.data.botIds![0]!, title: next.data.title });
        await next.moveToCompleted(undefined, `fresh-${i}`, false);
      }
      expect(completed).toEqual(
        expect.arrayContaining([
          { botId: 'bot-1', title: 'Fresh 7' },
          { botId: 'bot-2', title: 'Second bot' },
        ]),
      );
      expect(await queue.getJobCounts('wait', 'active', 'prioritized', 'delayed')).toEqual({
        wait: 0,
        active: 0,
        prioritized: 0,
        delayed: 0,
      });
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  }, 15000);
});
