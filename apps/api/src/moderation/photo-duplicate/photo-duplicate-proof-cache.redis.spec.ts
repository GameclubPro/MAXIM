import type Redis from 'ioredis';
import { createServer, type Socket } from 'node:net';
import { PhotoDuplicateHistoryStore } from './photo-duplicate-history.store';
import { PHOTO_FINGERPRINT_ALGORITHM_VERSION, type PhotoFingerprint } from './photo-fingerprint';

type FaultMode = 'silent' | 'trickle';
type StoreConnections = { redis: Redis; cacheRedis: Redis };

const fingerprint: PhotoFingerprint = {
  algorithmVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
  canonicalHash: 'b'.repeat(64),
  pdqHash: '0'.repeat(64),
  pdqQuality: 80,
  decodeCost: { encodedBytes: 100, pixels: 100 },
};
const cacheEntry = { photoId: 'local-proof', fingerprint };

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function within<T>(operation: Promise<T>, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Local cache lifecycle check timed out')), ms);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

function nextEvent(redis: Redis, event: 'ready' | 'end'): Promise<void> {
  return new Promise((resolve) => redis.once(event, () => resolve()));
}

function whenReady(redis: Redis): Promise<void> {
  return redis.status === 'ready' ? Promise.resolve() : nextEvent(redis, 'ready');
}

function offlineQueueLength(redis: Redis): number {
  return (redis as unknown as { offlineQueue: { length: number } }).offlineQueue.length;
}

function parseCommand(buffer: Buffer): { args: string[]; bytes: number } | null {
  const firstLineEnd = buffer.indexOf('\r\n');
  if (firstLineEnd < 0) return null;
  if (buffer[0] !== 42) throw new Error('Local Redis stub expected an array');
  const count = Number(buffer.subarray(1, firstLineEnd).toString());
  let cursor = firstLineEnd + 2;
  const args: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const lengthLineEnd = buffer.indexOf('\r\n', cursor);
    if (lengthLineEnd < 0) return null;
    if (buffer[cursor] !== 36) throw new Error('Local Redis stub expected a bulk string');
    const length = Number(buffer.subarray(cursor + 1, lengthLineEnd).toString());
    const start = lengthLineEnd + 2;
    if (buffer.length < start + length + 2) return null;
    args.push(buffer.subarray(start, start + length).toString());
    cursor = start + length + 2;
  }
  return { args, bytes: cursor };
}

function bulk(value: string): string {
  return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
}

async function createRedisFaultStub(mode: FaultMode) {
  const sockets = new Set<Socket>();
  const cacheValues = new Map<string, string>();
  const proofCommands: string[][] = [];
  const unsupportedCommands: string[] = [];
  let connectionCount = 0;
  let failProofCache = true;
  let trickleWrites = 0;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    connectionCount += 1;
    sockets.add(socket);
    const timers = new Set<ReturnType<typeof setInterval>>();
    let input = Buffer.alloc(0);
    socket.on('error', () => undefined);
    socket.once('close', () => {
      for (const timer of timers) clearInterval(timer);
      sockets.delete(socket);
    });
    socket.on('data', (chunk: Buffer) => {
      input = Buffer.concat([input, chunk]);
      let parsed: ReturnType<typeof parseCommand>;
      while ((parsed = parseCommand(input))) {
        input = input.subarray(parsed.bytes);
        const [name, ...args] = parsed.args;
        const command = name?.toUpperCase();
        if (command === 'CLIENT') socket.write('+OK\r\n');
        else if (command === 'INFO') {
          socket.write(bulk('redis_version:7.0.0\r\nloading:0\r\n'));
        } else if (command === 'PING') socket.write('+PONG\r\n');
        else if (command === 'QUIT') socket.end('+OK\r\n');
        else if (command === 'MGET' || command === 'SET') {
          proofCommands.push(parsed.args);
          if (failProofCache) {
            if (mode === 'trickle') {
              // Keep valid RESP bytes arriving without completing the pending response.
              socket.write(command === 'MGET' ? '*1\r\n$200\r\n' : '+');
              const timer = setInterval(() => {
                if (!socket.destroyed) {
                  trickleWrites += 1;
                  socket.write('x');
                }
              }, 40);
              timers.add(timer);
            }
          } else if (command === 'MGET') {
            socket.write(
              `*${args.length}\r\n` +
                args
                  .map((key) => (cacheValues.has(key) ? bulk(cacheValues.get(key)!) : '$-1\r\n'))
                  .join(''),
            );
          } else {
            cacheValues.set(args[0]!, args[1]!);
            socket.write('+OK\r\n');
          }
        } else {
          unsupportedCommands.push(command ?? '');
          socket.write('-ERR unsupported local fixture command\r\n');
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local Redis address missing');
  return {
    url: `redis://127.0.0.1:${address.port}`,
    proofCommands,
    unsupportedCommands,
    get connectionCount() {
      return connectionCount;
    },
    get trickleWrites() {
      return trickleWrites;
    },
    recover: () => {
      failProofCache = false;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('Photo proof cache real Redis client lifecycle', () => {
  it.each([
    ['silent', 'read'],
    ['silent', 'write'],
    ['trickle', 'read'],
    ['trickle', 'write'],
  ] as const)(
    'bounds retained commands for a %s peer during %s load and preserves authority',
    async (mode, operation) => {
      const peer = await createRedisFaultStub(mode);
      const store = new PhotoDuplicateHistoryStore({
        getOrThrow: () => peer.url,
        get: () => 250,
      } as never);
      const { redis: authority, cacheRedis: cache } = store as unknown as StoreConnections;
      const perform = () =>
        operation === 'read'
          ? store.getCachedPhotoFingerprints([cacheEntry.photoId])
          : store.cachePhotoFingerprints([cacheEntry], 60);
      try {
        await within(Promise.all([whenReady(authority), whenReady(cache)]));
        const authorityStream = authority.stream;
        const recovered = nextEvent(cache, 'ready');
        let peakCommandQueue = 0;
        let peakOfflineQueue = 0;
        await within(
          (async () => {
            for (let index = 0; index < 200; index += 1) {
              const pending = perform();
              peakCommandQueue = Math.max(peakCommandQueue, cache.commandQueue.length);
              peakOfflineQueue = Math.max(peakOfflineQueue, offlineQueueLength(cache));
              expect(await pending).toEqual(operation === 'read' ? { kind: 'unavailable' } : false);
            }
          })(),
        );
        expect(peer.proofCommands).toHaveLength(1);
        expect(peakCommandQueue).toBeLessThanOrEqual(1);
        expect(peakOfflineQueue).toBe(0);
        if (mode === 'trickle') expect(peer.trickleWrites).toBeGreaterThan(0);
        expect(authority.stream).toBe(authorityStream);
        await expect(authority.ping()).resolves.toBe('PONG');

        peer.recover();
        await within(recovered);
        expect(cache.commandQueue.length).toBe(0);
        expect(offlineQueueLength(cache)).toBe(0);
        await expect(store.cachePhotoFingerprints([cacheEntry], 60)).resolves.toBe(true);
        await expect(store.getCachedPhotoFingerprints([cacheEntry.photoId])).resolves.toEqual({
          kind: 'available',
          fingerprints: [fingerprint],
        });
        expect(peer.unsupportedCommands).toEqual([]);
        expect(authority.stream).toBe(authorityStream);

        const connectionsBeforeShutdown = peer.connectionCount;
        const ended = nextEvent(cache, 'end');
        await store.onModuleDestroy();
        await within(ended);
        await pause(150);
        expect(cache.status).toBe('end');
        expect(offlineQueueLength(cache)).toBe(0);
        expect(cache.commandQueue.length).toBe(0);
        expect(peer.connectionCount).toBe(connectionsBeforeShutdown);
      } finally {
        cache.disconnect();
        authority.disconnect();
        await peer.close();
      }
    },
    5_000,
  );
});
