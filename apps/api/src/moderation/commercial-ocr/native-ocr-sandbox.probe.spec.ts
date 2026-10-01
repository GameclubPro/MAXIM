import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { chmod, link, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as clock from './native-ocr-sandbox.clock';
import {
  probeNativeOcrSandboxReadiness,
  runNativeOcrSandboxReadinessProbe,
  serializeNativeOcrSandboxProbeExpectation,
} from './native-ocr-sandbox.probe';
import {
  decodeNativeOcrSandboxFrame,
  encodeNativeOcrSandboxFrame,
  NATIVE_OCR_SANDBOX_FRAME_KINDS,
  NATIVE_OCR_SANDBOX_HEADER_BYTES,
  NATIVE_OCR_SANDBOX_PROTOCOL_VERSION,
} from './native-ocr-sandbox.protocol';

const manifest = {
  artifacts: { binary: 'image-owned' },
  controls: { concurrency: 1, timeoutMs: 10_000 },
};
const fingerprint = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
const boundary = {
  transport: 'unix_socket',
  network: 'none',
  environment: 'allowlist',
  processGroupTeardown: 'verified_or_cgroup_recycle',
  instanceId: '00000000-0000-4000-8000-000000000001',
};

describe('Native OCR sandbox lightweight exact readiness', () => {
  let directory: string;
  let expectationPath: string;
  let socketPath: string;
  let server: Server | undefined;
  let ownerSpy: jest.SpyInstance;
  const sockets = new Set<Socket>();

  beforeEach(async () => {
    jest.spyOn(clock, 'assertNativeOcrSandboxSharedClock').mockImplementation(() => undefined);
    directory = await mkdtemp(join(tmpdir(), 'maxim-ocr-probe-'));
    expectationPath = join(directory, 'expectation.json');
    socketPath = join(directory, 'native.sock');
    await writeFile(expectationPath, serializeNativeOcrSandboxProbeExpectation(fingerprint), {
      mode: 0o444,
    });
    const realStat = fs.fstatSync;
    // Test fixtures cannot chown to root; keep all real stat attributes except the image owner.
    ownerSpy = jest.spyOn(fs, 'fstatSync').mockImplementation((descriptor) => {
      const stat = realStat(descriptor);
      return Object.assign(stat, { uid: 0 });
    });
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    jest.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  async function serve(reply: (socket: Socket, request: Buffer) => void): Promise<void> {
    server = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.once('close', () => sockets.delete(socket));
      socket.once('data', (request: Buffer) => reply(socket, request));
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
  }

  function frame(
    metadata: Record<string, unknown> = validMetadata(),
    payload = Buffer.alloc(0),
  ): Buffer {
    return encodeNativeOcrSandboxFrame({
      kind: NATIVE_OCR_SANDBOX_FRAME_KINDS.probeResponse,
      metadata,
      payload,
      limits: { metadataBytes: 128 * 1024, payloadBytes: 16 },
    });
  }

  function validMetadata(): Record<string, unknown> {
    return {
      status: 'ok',
      fingerprintSha256: fingerprint,
      identity: { fingerprintSha256: fingerprint, manifest },
      boundary,
    };
  }

  function probe(timeoutMs = 1_000): Promise<void> {
    return probeNativeOcrSandboxReadiness({ socketPath, expectationPath, timeoutMs });
  }

  it('requires an exact build fingerprint, complete manifest hash and live boundary over UDS', async () => {
    await serve((socket, request) => {
      const decoded = decodeNativeOcrSandboxFrame(request, {
        metadataBytes: 4 * 1024,
        payloadBytes: 0,
      });
      expect(decoded.kind).toBe(NATIVE_OCR_SANDBOX_FRAME_KINDS.probeRequest);
      expect(decoded.metadata).toEqual({});
      expect(decoded.payload.byteLength).toBe(0);
      const bytes = frame();
      socket.write(bytes.subarray(0, 7));
      socket.end(bytes.subarray(7));
    });
    await expect(probe()).resolves.toBeUndefined();
    expect(clock.assertNativeOcrSandboxSharedClock).toHaveBeenCalledTimes(1);
  });

  it('rejects an unverified clock before connecting to the sandbox', async () => {
    let connected = false;
    await serve((socket) => {
      connected = true;
      socket.end(frame());
    });
    jest.spyOn(clock, 'assertNativeOcrSandboxSharedClock').mockImplementation(() => {
      throw new Error('Native OCR sandbox shared monotonic clock is unverified');
    });
    await expect(probe()).rejects.toThrow(/shared monotonic clock/u);
    expect(connected).toBe(false);
  });

  it.each([
    ['wrong status', (metadata: Record<string, unknown>) => ({ ...metadata, status: 'error' })],
    [
      'wrong echoed fingerprint',
      (metadata: Record<string, unknown>) => ({ ...metadata, fingerprintSha256: '0'.repeat(64) }),
    ],
    [
      'wrong identity fingerprint',
      (metadata: Record<string, unknown>) => ({
        ...metadata,
        identity: { fingerprintSha256: '0'.repeat(64), manifest },
      }),
    ],
    [
      'changed manifest with matching echoed hashes',
      (metadata: Record<string, unknown>) => ({
        ...metadata,
        identity: { fingerprintSha256: fingerprint, manifest: { ...manifest, injected: true } },
      }),
    ],
    [
      'missing manifest',
      (metadata: Record<string, unknown>) => ({
        ...metadata,
        identity: { fingerprintSha256: fingerprint },
      }),
    ],
    [
      'incorrect boundary',
      (metadata: Record<string, unknown>) => ({
        ...metadata,
        boundary: { ...boundary, network: 'bridge' },
      }),
    ],
    [
      'invalid instance',
      (metadata: Record<string, unknown>) => ({
        ...metadata,
        boundary: { ...boundary, instanceId: 'arbitrary' },
      }),
    ],
  ])('rejects %s', async (_name, alter) => {
    await serve((socket) => socket.end(frame(alter(validMetadata()))));
    await expect(probe()).rejects.toThrow(/unverified/u);
  });

  it.each([
    'version',
    'type',
    'reserved',
    'oversized',
    'payload',
    'truncated',
    'trailing',
  ] as const)('rejects a %s response frame', async (corruption) => {
    await serve((socket) => {
      const bytes = frame();
      if (corruption === 'version') bytes.writeUInt8(NATIVE_OCR_SANDBOX_PROTOCOL_VERSION + 1, 4);
      if (corruption === 'type')
        bytes.writeUInt8(NATIVE_OCR_SANDBOX_FRAME_KINDS.recognizeResponse, 5);
      if (corruption === 'reserved') bytes.writeUInt16BE(1, 6);
      if (corruption === 'oversized') bytes.writeUInt32BE(64 * 1024 + 1, 8);
      if (corruption === 'payload') bytes.writeUInt32BE(1, 12);
      socket.end(
        corruption === 'truncated'
          ? bytes.subarray(0, bytes.length - 1)
          : corruption === 'trailing'
            ? Buffer.concat([bytes, Buffer.from([1])])
            : bytes,
      );
    });
    await expect(probe()).rejects.toThrow(/response/u);
  });

  it('rejects trailing bytes arriving after a complete first frame', async () => {
    await serve((socket) => {
      socket.write(frame());
      setImmediate(() => socket.end(Buffer.from([1])));
    });
    await expect(probe()).rejects.toThrow(/response/u);
  });

  it('fails an ordinary connection that never responds within its bounded deadline', async () => {
    await serve(() => undefined);
    await expect(probe(50)).rejects.toThrow(/timed out/u);
  });

  it('rejects an incomplete header without waiting for more than the deadline', async () => {
    await serve((socket) => socket.write(frame().subarray(0, NATIVE_OCR_SANDBOX_HEADER_BYTES - 1)));
    await expect(probe(50)).rejects.toThrow(/timed out/u);
  });

  it.each(['writable', 'symlink', 'hardlink', 'owner', 'protocol', 'noncanonical'] as const)(
    'rejects an untrusted %s expectation before connecting',
    async (corruption) => {
      let connected = false;
      await serve((socket) => {
        connected = true;
        socket.end(frame());
      });
      if (corruption === 'writable') await chmod(expectationPath, 0o644);
      if (corruption === 'symlink' || corruption === 'hardlink') {
        const alias = join(directory, 'alias.json');
        await (corruption === 'symlink'
          ? symlink(expectationPath, alias)
          : link(expectationPath, alias));
        expectationPath = alias;
      }
      if (corruption === 'owner')
        ownerSpy.mockImplementation((_descriptor: number) => ({
          ...fs.statSync(expectationPath),
          uid: 1,
          isFile: () => true,
        }));
      if (corruption === 'protocol' || corruption === 'noncanonical') {
        await chmod(expectationPath, 0o644);
        const value = JSON.parse(serializeNativeOcrSandboxProbeExpectation(fingerprint)) as Record<
          string,
          unknown
        >;
        if (corruption === 'protocol')
          value.protocolVersion = NATIVE_OCR_SANDBOX_PROTOCOL_VERSION + 1;
        await writeFile(
          expectationPath,
          corruption === 'noncanonical' ? JSON.stringify(value, null, 2) : JSON.stringify(value),
        );
        await chmod(expectationPath, 0o444);
      }
      await expect(probe()).rejects.toThrow();
      expect(connected).toBe(false);
    },
  );

  it('rejects an image artifact larger than its fixed bound', async () => {
    await chmod(expectationPath, 0o644);
    await writeFile(expectationPath, ' '.repeat(4 * 1024 + 1));
    await chmod(expectationPath, 0o444);
    await expect(probe()).rejects.toThrow(/expectation boundary/u);
  });

  it.each(['socket mode', 'directory mode'] as const)('rejects unsafe %s', async (corruption) => {
    await serve((socket) => socket.end(frame()));
    await chmod(corruption === 'socket mode' ? socketPath : directory, 0o777);
    await expect(probe()).rejects.toThrow(/socket boundary/u);
  });

  it('rejects missing sockets and non-socket filesystem entries', async () => {
    await expect(probe()).rejects.toThrow(/filesystem/u);
    await writeFile(socketPath, '', { mode: 0o600 });
    await expect(probe()).rejects.toThrow(/socket boundary/u);
  });

  it('does not accept a live socket outside the strict production directory', async () => {
    await expect(
      runNativeOcrSandboxReadinessProbe({ COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH: socketPath }),
    ).rejects.toThrow(/must be inside/u);
  });

  it('requires a configured production socket', async () => {
    await expect(runNativeOcrSandboxReadinessProbe({})).rejects.toThrow(/unconfigured/u);
  });
});
