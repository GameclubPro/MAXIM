import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Redis from 'ioredis';
import { RedisCounterService } from '../redis-counter.service';
import {
  buildCommercialCampaignSlidingSenderVelocityChatsKey,
  InMemoryCommercialCampaignSlidingWindow,
} from './commercial-campaign-sliding';

const executable = process.env.MAXIM_TEST_REDIS_SERVER;
const integration = executable ? it : it.skip;

function waitForReady(process: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error('Disposable Redis startup timed out')),
      5000,
    );
    const settle = (error?: Error) => {
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve();
    };
    process.once('error', (error) => settle(error));
    process.once('exit', (code) => settle(new Error(`Disposable Redis exited with ${code}`)));
    process.stdout?.on('data', (data: Buffer) => {
      if (
        data.toString().includes('ready to accept connections') ||
        data.toString().includes('Ready to accept connections')
      )
        settle();
    });
  });
}

describe('commercial campaign Lua/offline parity on disposable Redis', () => {
  integration(
    'agrees for rolling expiry, duplicate refresh, out-of-order events, invalid time and saturation',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'maxim-commercial-sliding-'));
      const socket = join(directory, 'redis.sock');
      const process = spawn(
        executable!,
        [
          '--port',
          '0',
          '--unixsocket',
          socket,
          '--unixsocketperm',
          '700',
          '--save',
          '',
          '--appendonly',
          'no',
          '--dir',
          directory,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let redis: Redis | undefined;
      try {
        await waitForReady(process);
        redis = new Redis({
          path: socket,
          lazyConnect: true,
          retryStrategy: () => null,
          maxRetriesPerRequest: 0,
        });
        await redis.connect();
        const service = Object.create(RedisCounterService.prototype) as RedisCounterService;
        Object.defineProperty(service, 'redis', { value: redis });
        const offline = new InMemoryCommercialCampaignSlidingWindow();
        const key = buildCommercialCampaignSlidingSenderVelocityChatsKey('parity-user', 300);
        const [seconds, micros] = await redis.time();
        const referenceMs = Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
        const events = [
          ['chat-1', -290000],
          ['chat-2', -20000],
          ['chat-1', -10000],
          ['chat-3', -15000],
          ['chat-1', -290001],
          ['stale-chat', -300001],
          ['future-chat', 31001],
          ['chat-4', 0],
        ] as const;
        for (const [chatId, offset] of events) {
          const [currentSeconds, currentMicros] = await redis.time();
          const nowMs = Number(currentSeconds) * 1000 + Math.floor(Number(currentMicros) / 1000);
          const eventTimestampMs = referenceMs + offset;
          const expected = offline.observe({
            key,
            chatId,
            eventTimestampMs,
            nowMs,
            windowSeconds: 300,
          });
          expect({
            chatId,
            result: await service.trackCommercialCampaignSlidingWindow({
              key,
              chatId,
              eventTimestampMs,
              windowSeconds: 300,
            }),
          }).toEqual({ chatId, result: expected });
        }
        for (let index = 0; index < 260; index += 1) {
          const chatId = `saturation-chat-${index}`;
          const [currentSeconds, currentMicros] = await redis.time();
          const nowMs = Number(currentSeconds) * 1000 + Math.floor(Number(currentMicros) / 1000);
          const expected = offline.observe({
            key,
            chatId,
            eventTimestampMs: nowMs,
            nowMs,
            windowSeconds: 300,
          });
          expect(
            await service.trackCommercialCampaignSlidingWindow({
              key,
              chatId,
              eventTimestampMs: nowMs,
              windowSeconds: 300,
            }),
          ).toEqual(expected);
        }
        expect(await redis.zcard(key)).toBe(256);
        const members = await redis.zrange(key, 0, -1);
        expect(members.every((member) => /^[a-f0-9]{64}$/u.test(member))).toBe(true);
        expect(members.some((member) => member.includes('chat'))).toBe(false);
      } finally {
        redis?.disconnect();
        if (process.pid !== undefined && process.exitCode === null && process.signalCode === null) {
          const stopped = new Promise<void>((resolve) => {
            const deadline = setTimeout(() => process.kill('SIGKILL'), 2000);
            process.once('exit', () => {
              clearTimeout(deadline);
              resolve();
            });
          });
          process.kill('SIGTERM');
          await stopped;
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
