import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import type Redis from 'ioredis';
import { createCommercialLlmRedis } from './commercial-llm-shadow.lease';
import { CommercialLlmWorkstationMailbox } from './commercial-llm-workstation.mailbox';
import {
  COMMERCIAL_LLM_WORKSTATION_KEYS as keys,
  COMMERCIAL_LLM_WORKSTATION_IDENTITY as identity,
} from './commercial-llm-workstation.protocol';
const url = process.env.MAXIM_TEST_REDIS_URL ?? '';
(url ? describe : describe.skip)('single expiring workstation slot on real Redis', () => {
  let redis: Redis, mailbox: CommercialLlmWorkstationMailbox;
  let owner: string;
  const response = JSON.stringify({
    model: identity.modelAlias,
    choices: [
      {
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: JSON.stringify({
            classification: 'NOT_COMMERCIAL',
            reasonCodes: ['PERSONAL_SALE'],
          }),
        },
      },
    ],
  });
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
      throw new Error('loopback disposable Redis required');
    redis = createCommercialLlmRedis(url);
    await redis.connect();
  });
  beforeEach(async () => {
    await redis.del(...Object.values(keys));
    owner = randomUUID();
    mailbox = new CommercialLlmWorkstationMailbox(redis, 400);
  });
  afterAll(async () => {
    await redis.del(...Object.values(keys));
    redis.disconnect();
  });
  const ready = async () => {
    expect(await mailbox.acquireWorker(owner)).toBe(true);
    await mailbox.refreshWorker(owner, true);
  };
  const request = async () => {
    for (let i = 0; i < 50; i++) {
      const value = await mailbox.refreshWorker(owner, true);
      if (value) return value;
      await pause(5);
    }
    throw new Error('request_missing');
  };
  it('skips offline PC immediately', async () => {
    expect(await mailbox.classify('synthetic')).toEqual({ outcome: 'UNAVAILABLE' });
  });
  it('admits only one worker and one request; returns true primary identity', async () => {
    await ready();
    expect(await mailbox.acquireWorker(randomUUID())).toBe(false);
    const first = mailbox.classify('synthetic');
    const item = await request();
    expect(await mailbox.classify('second')).toEqual({ outcome: 'BUSY' });
    expect(await mailbox.respond(randomUUID(), item.id, response)).toBe(false);
    expect(await mailbox.respond(owner, randomUUID(), response)).toBe(false);
    expect(await mailbox.respond(owner, item.id, response)).toBe(true);
    expect(await mailbox.respond(owner, item.id, response)).toBe(false);
    const result = await first;
    expect(result.outcome).toBe('COMPLETE');
    if (result.outcome === 'COMPLETE') expect(result.result).toMatchObject(identity);
    expect(await redis.exists(keys.request, keys.response)).toBe(0);
  });
  it('expires the request and rejects a late reply without a backlog', async () => {
    await ready();
    const first = mailbox.classify('synthetic');
    const item = await request();
    expect(await first).toEqual({ outcome: 'TIMEOUT' });
    await pause(30);
    expect(await mailbox.respond(owner, item.id, response)).toBe(false);
    expect(await redis.exists(keys.request, keys.response)).toBe(0);
  });
  it('a stale worker cannot remove a newer worker or its heartbeat', async () => {
    await ready();
    await redis.pexpire(keys.lease, 1);
    await pause(10);
    const nextOwner = randomUUID();
    expect(await mailbox.acquireWorker(nextOwner)).toBe(true);
    await mailbox.refreshWorker(nextOwner, true);
    await mailbox.releaseWorker(owner);
    expect(await redis.get(keys.lease)).toBe(nextOwner);
    expect(JSON.parse((await redis.get(keys.heartbeat))!)).toMatchObject({ owner: nextOwner });
  });
  it('disconnect removes only the owned slot and subsequent calls skip immediately', async () => {
    await ready();
    const first = mailbox.classify('synthetic');
    await request();
    await mailbox.releaseWorker(owner);
    expect(await mailbox.classify('next')).toEqual({ outcome: 'UNAVAILABLE' });
    await first;
    expect(await redis.exists(...Object.values(keys))).toBe(0);
  });
  it.each(['null', '{"model":"wrong","choices":[]}', 'broken'])(
    'rejects malformed/unbound output %s',
    async (body) => {
      await ready();
      const first = mailbox.classify('synthetic');
      const item = await request();
      await mailbox.respond(owner, item.id, body);
      expect(await first).toEqual({ outcome: 'FAILED' });
    },
  );
  it('refuses oversized output and cleans the cancelled slot', async () => {
    await ready();
    const controller = new AbortController();
    const first = mailbox.classify('synthetic', controller.signal);
    const assertion = expect(first).rejects.toMatchObject({ kind: 'ABORTED' });
    const item = await request();
    expect(await mailbox.respond(owner, item.id, 'x'.repeat(16385))).toBe(false);
    controller.abort();
    await assertion;
    await pause(30);
    expect(await redis.exists(keys.request, keys.response)).toBe(0);
  });
});
