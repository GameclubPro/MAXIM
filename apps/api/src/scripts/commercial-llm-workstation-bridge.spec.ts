import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import type Redis from 'ioredis';
import { createCommercialLlmRedis } from '../moderation/commercial/commercial-llm-shadow.lease';
import { CommercialLlmWorkstationMailbox } from '../moderation/commercial/commercial-llm-workstation.mailbox';
import {
  COMMERCIAL_LLM_WORKSTATION_IDENTITY as identity,
  COMMERCIAL_LLM_WORKSTATION_KEYS as keys,
} from '../moderation/commercial/commercial-llm-workstation.protocol';
const url = process.env.MAXIM_TEST_REDIS_URL ?? '';
(url ? describe : describe.skip)('SSH workstation bridge process with real Redis', () => {
  let redis: Redis, child: ChildProcessWithoutNullStreams | undefined;
  let frames: Record<string, unknown>[];
  let closed: Promise<unknown>;
  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
      throw new Error('disposable Redis required');
    redis = createCommercialLlmRedis(url);
    await redis.connect();
  });
  beforeEach(async () => {
    await redis.del(...Object.values(keys));
    frames = [];
  });
  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      await closed;
    }
    child = undefined;
    await redis.del(...Object.values(keys));
  });
  afterAll(() => redis.disconnect());
  function launch() {
    child = spawn(
      process.execPath,
      ['--import', 'tsx', resolve('src/scripts/commercial-llm-workstation-bridge.ts')],
      {
        env: {
          PATH: process.env.PATH,
          REDIS_URL: url,
          APP_SERVICE_NAME: 'api-moderation-background',
          COMMERCIAL_LLM_SHADOW_ENABLED: 'true',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    closed = once(child, 'close');
    let pending = '';
    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString();
      let at;
      while ((at = pending.indexOf('\n')) >= 0) {
        frames.push(JSON.parse(pending.slice(0, at)));
        pending = pending.slice(at + 1);
      }
    });
    child.stderr.resume();
    return child;
  }
  async function waitFor<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      const value = await read();
      if (accepts(value)) return value;
      await pause(10);
    }
    throw new Error('bridge_test_deadline');
  }
  it('handshakes, classifies one sanitized request and releases owned state on EOF', async () => {
    launch().stdin.write(JSON.stringify({ type: 'hello', identity }) + '\n');
    await waitFor(
      async () => frames,
      (value) => value.some((x) => x.type === 'hello'),
    );
    child!.stdin.write(JSON.stringify({ type: 'ready', ready: true }) + '\n');
    await waitFor(() => redis.get(keys.heartbeat), Boolean);
    const mailbox = new CommercialLlmWorkstationMailbox(redis);
    const result = mailbox.classify('Продам свой старый холодильник');
    await waitFor(
      async () => frames,
      (value) => value.some((x) => x.type === 'request'),
    );
    const request = frames.find((x) => x.type === 'request')!;
    child!.stdin.write(
      JSON.stringify({
        type: 'response',
        id: request.id,
        body: JSON.stringify({
          model: identity.modelAlias,
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: '{"classification":"NOT_COMMERCIAL","reasonCodes":["PERSONAL_SALE"]}',
              },
            },
          ],
        }),
      }) + '\n',
    );
    expect(await result).toMatchObject({
      outcome: 'COMPLETE',
      result: { modelAlias: identity.modelAlias },
    });
    child!.stdin.end();
    await closed;
    expect(await redis.exists(...Object.values(keys))).toBe(0);
  });
  it.each(['foreign', 'oversized', 'malformed'])(
    'ends a %s session and never advertises it as ready',
    async (kind) => {
      launch();
      child!.stdin.write(
        kind === 'foreign'
          ? JSON.stringify({ type: 'hello', identity: { ...identity, modelSha256: 'foreign' } }) +
              '\n'
          : kind === 'oversized'
            ? 'x'.repeat(65537)
            : 'bad-json\n',
      );
      await closed;
      expect(await redis.exists(...Object.values(keys))).toBe(0);
      expect(frames).toEqual([]);
    },
  );
});
